import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, SourceType } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { ConfigModule } from './../src/config/config.module';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { DeadLetterRetryUnavailableError } from './../src/queue/pipeline-stage-queue';
import { InvoiceStateMachine } from './../src/queue/invoice-state-machine';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { QueueModule } from './../src/queue/queue.module';
import {
  PipelineStageProcessor,
  type ClaimableInvoice,
} from './../src/queue/pipeline-stage.processor';
import type {
  FailedStageJob,
  LifecycleJobData,
  PipelineStageQueue,
} from './../src/queue/pipeline-stage-queue';
import {
  VALIDATION_RETRY_EXHAUSTED_FAILURE,
  ValidationQueue,
} from './../src/validation/validation-queue.service';

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required for e2e tests');
  return url;
}

function queuePrefix(): string {
  const prefix = process.env.QUEUE_PREFIX;
  if (!prefix) throw new Error('QUEUE_PREFIX is required for e2e tests');
  return prefix;
}

// Not ValidationModule: that would start a real ValidationProcessor racing this suite's synthetic jobs.
function buildValidationQueueModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      QueueModule,
      BullModule.registerQueue(
        { name: PipelineStage.VALIDATION },
        { name: dlqQueueName(PipelineStage.VALIDATION) },
      ),
    ],
    providers: [
      ValidationQueue,
      {
        provide: PinoLogger,
        useValue: { error: jest.fn(), setContext: jest.fn() },
      },
    ],
  }).compile();
}

class RaceTestProcessor extends PipelineStageProcessor {
  protected readonly stateMachine: InvoiceStateMachine;
  protected readonly stageQueue: PipelineStageQueue;
  protected readonly stageLogger = {
    info: jest.fn(),
    setContext: jest.fn(),
  } as unknown as PinoLogger;

  constructor(
    stateMachine: InvoiceStateMachine,
    stageQueue: PipelineStageQueue,
  ) {
    super();
    this.stateMachine = stateMachine;
    this.stageQueue = stageQueue;
  }

  protected async processInvoice(): Promise<void> {}

  acceptJob<Invoice extends ClaimableInvoice>(
    job: FailedStageJob,
    invoice: Invoice | null,
  ): Promise<Invoice | null> {
    return this.acceptStageJob(job, invoice);
  }
}

describe('Pipeline stage processor recovery under real PostgreSQL + Redis (e2e)', () => {
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let stateMachine: InvoiceStateMachine;
  let validationQueue: ValidationQueue;
  let dlq: Queue;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    moduleFixture = await buildValidationQueueModule();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
    stateMachine = moduleFixture.get(InvoiceStateMachine);
    validationQueue = moduleFixture.get(ValidationQueue);
    dlq = moduleFixture.get<Queue>(
      getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
    );
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await moduleFixture.close();
  });

  it('does not recreate a dead letter for an expired lifecycle the cleanup service already removed', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoiceId = randomUUID();
    const storageKey = randomUUID();
    const staleSnapshot: ClaimableInvoice = {
      id: invoiceId,
      storageKey,
      status: InvoiceStatus.FAILED,
      failureCode: VALIDATION_RETRY_EXHAUSTED_FAILURE.code,
      expiresAt: new Date(Date.now() - 1000),
    };
    const job: FailedStageJob = {
      name: PipelineStage.VALIDATION,
      data: { invoiceId, storageKey },
      failedReason: 'llm timeout',
      attemptsMade: 0,
    };
    const jobId = lifecycleJobIdFor(
      PipelineStage.VALIDATION,
      invoiceId,
      storageKey,
    );

    const processor = new RaceTestProcessor(stateMachine, validationQueue);
    await expect(processor.acceptJob(job, staleSnapshot)).resolves.toBeNull();

    expect(await dlq.getJob(jobId)).toBeUndefined();
    expect(
      await prisma.invoice.findUnique({ where: { id: invoiceId } }),
    ).toBeNull();
  });
});

describe('retryFromDlq crash matrix under real PostgreSQL + Redis (e2e)', () => {
  jest.setTimeout(30_000);

  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let stateMachine: InvoiceStateMachine;
  let validationQueue: ValidationQueue;
  let primaryQueue: Queue;
  let dlq: Queue;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    moduleFixture = await buildValidationQueueModule();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
    stateMachine = moduleFixture.get(InvoiceStateMachine);
    validationQueue = moduleFixture.get(ValidationQueue);
    primaryQueue = moduleFixture.get<Queue>(
      getQueueToken(PipelineStage.VALIDATION),
    );
    dlq = moduleFixture.get<Queue>(
      getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
    );
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await moduleFixture.close();
  });

  async function seedExhaustedLifecycle(): Promise<{
    invoiceId: string;
    storageKey: string;
    jobId: string;
  }> {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const storageKey = randomUUID();
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey,
        originalFilename: 'crash-matrix.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.VALIDATING,
        sourceType: SourceType.NATIVE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const jobId = lifecycleJobIdFor(
      PipelineStage.VALIDATION,
      invoice.id,
      storageKey,
    );

    const worker = new Worker<LifecycleJobData>(
      PipelineStage.VALIDATION,
      () => {
        throw new Error('synthetic exhaustion');
      },
      {
        connection: { url: redisUrl(), maxRetriesPerRequest: null },
        prefix: queuePrefix(),
      },
    );
    try {
      const exhausted = new Promise<Job<LifecycleJobData>>((resolve) => {
        worker.on('failed', (job) => {
          if (job?.id === jobId && job.attemptsMade >= 1) resolve(job);
        });
      });
      await primaryQueue.add(
        PipelineStage.VALIDATION,
        { invoiceId: invoice.id, storageKey },
        {
          jobId,
          attempts: 1,
          backoff: { type: 'fixed', delay: 10 },
          removeOnFail: { age: 3600 },
        },
      );
      const failedJob = await exhausted;
      await validationQueue.finalizeFailure(
        failedJob,
        new Error('synthetic exhaustion'),
      );
    } finally {
      await worker.close();
    }

    return { invoiceId: invoice.id, storageKey, jobId };
  }

  it('case 1: a clean retry discards the retained failed primary and startup reconciliation leaves it alone', async () => {
    const { invoiceId, jobId } = await seedExhaustedLifecycle();

    await validationQueue.retryFromDlq(invoiceId);

    const row = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    expect(row.status).toBe(InvoiceStatus.VALIDATING);
    expect(row.failureCode).toBeNull();
    expect(await dlq.getJob(jobId)).toBeUndefined();
    const primary = await primaryQueue.getJob(jobId);
    expect(primary).toBeDefined();
    expect(await primary?.getState()).not.toBe('failed');

    await expect(validationQueue.reconcileFailedJobs()).resolves.toBe(0);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }))
        .status,
    ).toBe(InvoiceStatus.VALIDATING);
  });

  it('case 2: a crash after reopen but before republish leaves the lifecycle reconcilable, not re-failed', async () => {
    const { invoiceId, storageKey, jobId } = await seedExhaustedLifecycle();

    await primaryQueue.getJob(jobId).then((job) => job?.remove());
    await expect(
      stateMachine.reopenAfterDeadLetter({
        invoiceId,
        storageKey,
        to: InvoiceStatus.VALIDATING,
      }),
    ).resolves.toBe('claimed');

    expect(await primaryQueue.getJob(jobId)).toBeUndefined();
    await expect(validationQueue.reconcileFailedJobs()).resolves.toBe(0);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }))
        .status,
    ).toBe(InvoiceStatus.VALIDATING);

    await validationQueue.retryFromDlq(invoiceId);

    expect(await dlq.getJob(jobId)).toBeUndefined();
    const primary = await primaryQueue.getJob(jobId);
    expect(primary).toBeDefined();
    expect(await primary?.getState()).not.toBe('failed');
  });

  it('case 3 & 4: a crash after republish but before the dead letter is removed resumes idempotently, twice in a row', async () => {
    const { invoiceId, storageKey, jobId } = await seedExhaustedLifecycle();

    await primaryQueue.getJob(jobId).then((job) => job?.remove());
    await stateMachine.reopenAfterDeadLetter({
      invoiceId,
      storageKey,
      to: InvoiceStatus.VALIDATING,
    });
    await primaryQueue.add(
      PipelineStage.VALIDATION,
      { invoiceId, storageKey },
      { jobId },
    );
    expect(await dlq.getJob(jobId)).toBeDefined();

    await expect(
      validationQueue.retryFromDlq(invoiceId),
    ).resolves.toBeUndefined();
    expect(await dlq.getJob(jobId)).toBeUndefined();
    const primaryAfterFirstRetry = await primaryQueue.getJob(jobId);
    expect(primaryAfterFirstRetry).toBeDefined();

    await expect(validationQueue.retryFromDlq(invoiceId)).rejects.toThrow(
      DeadLetterRetryUnavailableError,
    );
    const primaryAfterSecondRetry = await primaryQueue.getJob(jobId);
    expect(primaryAfterSecondRetry?.id).toBe(primaryAfterFirstRetry?.id);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }))
        .status,
    ).toBe(InvoiceStatus.VALIDATING);
  });

  it('case 5: a concurrent retry loser does not corrupt the lifecycle or duplicate the primary job', async () => {
    const { invoiceId, jobId } = await seedExhaustedLifecycle();

    const results = await Promise.allSettled([
      validationQueue.retryFromDlq(invoiceId),
      validationQueue.retryFromDlq(invoiceId),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(DeadLetterRetryUnavailableError);
      }
    }
    expect(await dlq.getJob(jobId)).toBeUndefined();
    const primaryJobs = await primaryQueue.getJobs([
      'waiting',
      'active',
      'delayed',
    ]);
    expect(primaryJobs.filter((job) => job.id === jobId)).toHaveLength(1);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }))
        .status,
    ).toBe(InvoiceStatus.VALIDATING);
  });
});
