import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from './invoice-state-machine';
import { lifecycleJobIdFor, PipelineStage } from './pipeline-stage';
import {
  type DeadLetterJobData,
  type FailedStageJob,
  type LifecycleJobData,
  PipelineStageQueue,
} from './pipeline-stage-queue';

const JOB_DATA = { invoiceId: 'invoice-1', storageKey: 'storage-key-1' };
const RETRY_EXHAUSTED_FAILURE = {
  code: 'text_extraction_retries_exhausted',
} as const;

class TestStageQueue extends PipelineStageQueue {
  constructor(
    queue: Queue<LifecycleJobData>,
    dlq: Queue<DeadLetterJobData>,
    stateMachine: InvoiceStateMachine,
    prisma: PrismaService,
    logger: PinoLogger,
  ) {
    super(
      queue,
      dlq,
      stateMachine,
      prisma,
      {
        stage: PipelineStage.TEXT_EXTRACTION,
        claimFrom: InvoiceStatus.UPLOADED,
        claimTo: InvoiceStatus.EXTRACTING_TEXT,
        retryExhaustedFailure: RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_TEXT,
      },
      2,
      logger,
    );
  }
}

describe('PipelineStageQueue', () => {
  let stageQueue: TestStageQueue;
  let queue: { add: jest.Mock; getJobs: jest.Mock; getJob: jest.Mock };
  let dlq: { add: jest.Mock; getJob: jest.Mock };
  let stateMachine: {
    reopenAfterDeadLetter: jest.Mock;
    failIrrecoverably: jest.Mock;
  };
  let prisma: { invoice: { findUnique: jest.Mock } };
  let logger: { info: jest.Mock; error: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    logger = { info: jest.fn(), error: jest.fn(), setContext: jest.fn() };
    queue = {
      add: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    dlq = { add: jest.fn(), getJob: jest.fn() };
    stateMachine = {
      reopenAfterDeadLetter: jest.fn(),
      failIrrecoverably: jest.fn(),
    };
    prisma = {
      invoice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ storageKey: JOB_DATA.storageKey }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: TestStageQueue,
          useFactory: () =>
            new TestStageQueue(
              queue as unknown as Queue<LifecycleJobData>,
              dlq as unknown as Queue<DeadLetterJobData>,
              stateMachine as unknown as InvoiceStateMachine,
              prisma as unknown as PrismaService,
              logger as unknown as PinoLogger,
            ),
        },
      ],
    }).compile();

    stageQueue = module.get(TestStageQueue);
  });

  it('deduplicates active jobs within one storage lifecycle', async () => {
    await stageQueue.enqueue(JOB_DATA);

    expect(queue.add).toHaveBeenCalledWith(
      PipelineStage.TEXT_EXTRACTION,
      JOB_DATA,
      expect.objectContaining({
        jobId: lifecycleJobIdFor(
          PipelineStage.TEXT_EXTRACTION,
          JOB_DATA.invoiceId,
          JOB_DATA.storageKey,
        ),
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnFail: { age: 7200 },
      }),
    );
  });

  describe('finalizeFailure', () => {
    function failedJob(): FailedStageJob {
      return {
        name: 'extract',
        data: JOB_DATA,
        failedReason: '',
        attemptsMade: 0,
      };
    }

    it('hard-fails the lifecycle and dead-letters it', async () => {
      stateMachine.failIrrecoverably.mockResolvedValue('claimed');

      await stageQueue.finalizeFailure(
        failedJob(),
        new Error('disk unavailable'),
      );

      expect(stateMachine.failIrrecoverably).toHaveBeenCalledWith({
        invoiceId: JOB_DATA.invoiceId,
        storageKey: JOB_DATA.storageKey,
        from: stageQueue.inFlightStatuses,
        failure: RETRY_EXHAUSTED_FAILURE,
      });
      expect(dlq.add).toHaveBeenCalledWith(
        'extract',
        expect.objectContaining({ failureReason: 'disk unavailable' }),
        expect.anything(),
      );
    });

    it('does not dead-letter a job whose lifecycle has moved on', async () => {
      stateMachine.failIrrecoverably.mockResolvedValue('lost');

      await stageQueue.finalizeFailure(
        failedJob(),
        new Error('disk unavailable'),
      );

      expect(dlq.add).not.toHaveBeenCalled();
    });

    it('reports the terminal dead-letter as a stage event', async () => {
      stateMachine.failIrrecoverably.mockResolvedValue('claimed');

      await stageQueue.finalizeFailure(
        { ...failedJob(), attemptsMade: 3, processedOn: Date.now() - 40 },
        new Error('disk unavailable'),
      );

      expect(logger.info).toHaveBeenCalledWith(
        {
          invoiceId: JOB_DATA.invoiceId,
          stage: PipelineStage.TEXT_EXTRACTION,
          outcome: 'dead-letter',
          durationMs: expect.any(Number) as number,
          attempt: 3,
        },
        'Pipeline stage finished',
      );
    });

    it('reports a lifecycle that has moved on as stale work, not as a dead letter', async () => {
      stateMachine.failIrrecoverably.mockResolvedValue('lost');

      await stageQueue.finalizeFailure(
        failedJob(),
        new Error('disk unavailable'),
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'skipped-stale' }),
        'Pipeline stage finished',
      );
    });

    it('never throws, so the original failure is what returns to BullMQ', async () => {
      stateMachine.failIrrecoverably.mockRejectedValue(new Error('db down'));

      await expect(
        stageQueue.finalizeFailure(failedJob(), new Error('disk unavailable')),
      ).resolves.toBeUndefined();
    });
  });

  it('dead-letters the failed lifecycle with its diagnostic', async () => {
    await stageQueue.moveToDlq({
      name: 'extract',
      data: JOB_DATA,
      failedReason: 'storage unavailable',
      attemptsMade: 0,
    });

    expect(dlq.add).toHaveBeenCalledWith(
      'extract',
      {
        ...JOB_DATA,
        failedAt: expect.any(String) as string,
        failureReason: 'storage unavailable',
      },
      {
        jobId: lifecycleJobIdFor(
          PipelineStage.TEXT_EXTRACTION,
          JOB_DATA.invoiceId,
          JOB_DATA.storageKey,
        ),
      },
    );
  });

  describe('requeueStranded', () => {
    it('reports true when the add genuinely queues a fresh job', async () => {
      queue.add.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('waiting'),
      });

      await expect(stageQueue.requeueStranded(JOB_DATA)).resolves.toBe(true);
    });

    it('reports false when add() silently deduped against a stale terminal job', async () => {
      queue.add.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('failed'),
      });

      await expect(stageQueue.requeueStranded(JOB_DATA)).resolves.toBe(false);
    });
  });

  describe('reconcileFailedJobs', () => {
    function failedJob(storageKey = JOB_DATA.storageKey) {
      return {
        name: 'extract',
        data: { ...JOB_DATA, storageKey },
        failedReason: 'disk unavailable',
        remove: jest.fn(),
      };
    }

    it('moves a retained exhausted job to the lifecycle DLQ', async () => {
      const job = failedJob();
      queue.getJobs.mockResolvedValue([job]);
      stateMachine.failIrrecoverably.mockResolvedValue('claimed');

      await expect(stageQueue.reconcileFailedJobs()).resolves.toBe(1);

      expect(dlq.add).toHaveBeenCalledWith(
        'extract',
        expect.objectContaining({
          ...JOB_DATA,
          failureReason: 'disk unavailable',
        }),
        {
          jobId: lifecycleJobIdFor(
            PipelineStage.TEXT_EXTRACTION,
            JOB_DATA.invoiceId,
            JOB_DATA.storageKey,
          ),
        },
      );
      expect(job.remove).not.toHaveBeenCalled();
    });

    it('reports each startup-reconciled failure as a dead-letter stage event', async () => {
      queue.getJobs.mockResolvedValue([failedJob()]);
      stateMachine.failIrrecoverably.mockResolvedValue('claimed');

      await stageQueue.reconcileFailedJobs();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: JOB_DATA.invoiceId,
          stage: PipelineStage.TEXT_EXTRACTION,
          outcome: 'dead-letter',
          durationMs: null,
        }),
        'Pipeline stage finished',
      );
    });

    it('ignores a retained job from an expired lifecycle', async () => {
      const job = failedJob('old-storage-key');
      queue.getJobs.mockResolvedValue([job]);
      stateMachine.failIrrecoverably.mockResolvedValue('lost');

      await expect(stageQueue.reconcileFailedJobs()).resolves.toBe(0);

      expect(dlq.add).not.toHaveBeenCalled();
      expect(job.remove).not.toHaveBeenCalled();
    });
  });

  describe('retryFromDlq', () => {
    function deadLetterJob() {
      return {
        name: 'extract',
        data: {
          ...JOB_DATA,
          failedAt: '2026-08-10T12:00:00.000Z',
          failureReason: 'storage unavailable',
        },
        remove: jest.fn(),
      };
    }

    it('reopens the matching lifecycle, re-adds it, and removes the dead letter', async () => {
      const dlqJob = deadLetterJob();
      dlq.getJob.mockResolvedValue(dlqJob);
      stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

      await stageQueue.retryFromDlq(JOB_DATA.invoiceId);

      expect(stateMachine.reopenAfterDeadLetter).toHaveBeenCalledWith({
        ...JOB_DATA,
        to: InvoiceStatus.EXTRACTING_TEXT,
      });
      expect(queue.add).toHaveBeenCalledWith(
        'extract',
        JOB_DATA,
        expect.objectContaining({
          jobId: lifecycleJobIdFor(
            PipelineStage.TEXT_EXTRACTION,
            JOB_DATA.invoiceId,
            JOB_DATA.storageKey,
          ),
        }),
      );
      expect(dlqJob.remove).toHaveBeenCalled();
    });

    it('removes a retained failed primary job before reopening', async () => {
      const dlqJob = deadLetterJob();
      const failedPrimary = {
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn(),
      };
      dlq.getJob.mockResolvedValue(dlqJob);
      queue.getJob.mockResolvedValue(failedPrimary);
      stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

      await stageQueue.retryFromDlq(JOB_DATA.invoiceId);

      expect(failedPrimary.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });

    it('finishes cleanup idempotently when a primary job already published this lifecycle', async () => {
      const dlqJob = deadLetterJob();
      const publishedPrimary = {
        getState: jest.fn().mockResolvedValue('waiting'),
        remove: jest.fn(),
      };
      dlq.getJob.mockResolvedValue(dlqJob);
      queue.getJob.mockResolvedValue(publishedPrimary);
      stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

      await expect(
        stageQueue.retryFromDlq(JOB_DATA.invoiceId),
      ).resolves.toBeUndefined();

      expect(publishedPrimary.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(dlqJob.remove).toHaveBeenCalled();
    });

    it('throws when no dead-lettered job exists', async () => {
      dlq.getJob.mockResolvedValue(undefined);

      await expect(stageQueue.retryFromDlq(JOB_DATA.invoiceId)).rejects.toThrow(
        JOB_DATA.invoiceId,
      );
      expect(stateMachine.reopenAfterDeadLetter).not.toHaveBeenCalled();
    });

    it('throws when the invoice no longer exists', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(stageQueue.retryFromDlq(JOB_DATA.invoiceId)).rejects.toThrow(
        'does not exist',
      );
      expect(dlq.getJob).not.toHaveBeenCalled();
    });

    it('deletes a dead letter from an expired storage lifecycle', async () => {
      const dlqJob = deadLetterJob();
      dlq.getJob.mockResolvedValue(dlqJob);
      stateMachine.reopenAfterDeadLetter.mockResolvedValue('lost');

      await expect(stageQueue.retryFromDlq(JOB_DATA.invoiceId)).rejects.toThrow(
        'expired lifecycle',
      );

      expect(queue.add).not.toHaveBeenCalled();
      expect(dlqJob.remove).toHaveBeenCalled();
    });

    it('keeps the dead letter when re-adding the reopened lifecycle fails', async () => {
      const dlqJob = deadLetterJob();
      dlq.getJob.mockResolvedValue(dlqJob);
      stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');
      queue.add.mockRejectedValue(new Error('redis unavailable'));

      await expect(stageQueue.retryFromDlq(JOB_DATA.invoiceId)).rejects.toThrow(
        'redis unavailable',
      );

      expect(dlqJob.remove).not.toHaveBeenCalled();
    });
  });
});
