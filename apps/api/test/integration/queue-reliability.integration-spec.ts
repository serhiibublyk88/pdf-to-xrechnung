import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';

function connection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for Redis integration tests');
  }
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
  } as const;
}

describe('BullMQ queue reliability (real Redis)', () => {
  jest.setTimeout(20_000);

  let queueName: string;
  let queue: Queue;
  const workers: Worker[] = [];
  const extraQueues: Queue[] = [];

  beforeEach(() => {
    queueName = `test-${randomUUID()}`;
    queue = new Queue(queueName, { connection: connection() });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close(true)));
    await Promise.all(
      extraQueues.splice(0).map(async (extraQueue) => {
        await extraQueue.obliterate({ force: true });
        await extraQueue.close();
      }),
    );
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('processes a job added twice under the same jobId only once', async () => {
    let processed = 0;
    const worker = new Worker(
      queueName,
      () => {
        processed++;
        return Promise.resolve();
      },
      { connection: connection() },
    );
    workers.push(worker);
    const completed = new Promise<void>((resolve) => {
      worker.once('completed', () => resolve());
    });

    await queue.add('extract', { invoiceId: 'x' }, { jobId: 'fixed-id' });
    await queue.add('extract', { invoiceId: 'x' }, { jobId: 'fixed-id' });

    // The dedup Lua script runs inside add(), so no second job exists to wait for.
    expect(
      await queue.getJobCountByTypes('waiting', 'active', 'completed'),
    ).toBe(1);

    await completed;

    expect(processed).toBe(1);
    expect(await queue.getJobCountByTypes('waiting', 'active')).toBe(0);
  });

  it('retains the exhausted primary job after synchronously writing its dead letter', async () => {
    const dlq = new Queue(`${queueName}-dlq`, { connection: connection() });
    extraQueues.push(dlq);

    const attempts = 3;
    let attemptCount = 0;
    const worker = new Worker(
      queueName,
      async (job): Promise<void> => {
        attemptCount++;
        if (job.attemptsMade + 1 >= attempts) {
          await dlq.add(job.name, job.data, { jobId: job.id });
        }
        throw new Error('boom');
      },
      { connection: connection() },
    );
    workers.push(worker);

    const exhausted = new Promise<void>((resolve) => {
      worker.on('failed', (job) => {
        if (!job || job.attemptsMade < attempts) {
          return;
        }
        resolve();
      });
    });

    await queue.add(
      'extract',
      { invoiceId: 'x' },
      {
        jobId: 'exhausting-job',
        attempts,
        backoff: { type: 'fixed', delay: 20 },
        removeOnFail: { age: 60 },
      },
    );

    await exhausted;

    expect(attemptCount).toBe(attempts);
    const dlqJob = await dlq.getJob('exhausting-job');
    expect(dlqJob?.data).toEqual({ invoiceId: 'x' });
    expect(await queue.getJob('exhausting-job')).toBeDefined();
  });

  it('resumes a job on a new worker after the original worker is killed mid-job', async () => {
    const stalledDetection = { lockDuration: 1000, stalledInterval: 1000 };

    let workerA: Worker | undefined;
    const workerAStarted = new Promise<void>((resolve) => {
      workerA = new Worker(
        queueName,
        () => {
          resolve();
          return new Promise(() => {});
        },
        { connection: connection(), ...stalledDetection },
      );
    });

    await queue.add('extract', { invoiceId: 'x' }, { jobId: 'stall-me' });
    await workerAStarted;

    if (!workerA) throw new Error('First worker did not start');
    await workerA.close(true);

    let completed = false;
    const workerB = new Worker(
      queueName,
      () => {
        completed = true;
        return Promise.resolve();
      },
      { connection: connection(), ...stalledDetection },
    );
    workers.push(workerB);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('job never resumed on the new worker')),
        10_000,
      );
      workerB.once('completed', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(completed).toBe(true);
  });

  it('lets an in-flight job finish and leaves a waiting job untouched on a graceful close', async () => {
    let firstJobCompleted = false;
    const worker = new Worker(
      queueName,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        firstJobCompleted = true;
      },
      { connection: connection() },
    );
    workers.push(worker);

    const active = new Promise<void>((resolve) => {
      worker.on('active', () => resolve());
    });
    await queue.add('extract', { invoiceId: 'in-flight' }, { jobId: 'job-1' });
    await active;

    await queue.add(
      'extract',
      { invoiceId: 'still-waiting' },
      { jobId: 'job-2' },
    );

    await worker.close();

    expect(firstJobCompleted).toBe(true);
    const waitingJob = await queue.getJob('job-2');
    expect(await waitingJob?.getState()).toBe('waiting');
  });
});
