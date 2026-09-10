import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from '../queue/pipeline-stage';
import type { FailedStageJob } from '../queue/pipeline-stage-queue';
import {
  TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  TextExtractionQueue,
} from './text-extraction-queue.service';

const JOB_DATA = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

describe('TextExtractionQueue', () => {
  let textExtractionQueue: TextExtractionQueue;
  let queue: { add: jest.Mock; getJobs: jest.Mock; getJob: jest.Mock };
  let dlq: { add: jest.Mock; getJob: jest.Mock };
  let stateMachine: {
    reopenAfterDeadLetter: jest.Mock;
    failIrrecoverably: jest.Mock;
  };
  let prisma: { invoice: { findUnique: jest.Mock } };

  beforeEach(async () => {
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
        TextExtractionQueue,
        {
          provide: getQueueToken(PipelineStage.TEXT_EXTRACTION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
          useValue: dlq,
        },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => 2 } },
        {
          provide: PinoLogger,
          useValue: { error: jest.fn(), setContext: jest.fn() },
        },
      ],
    }).compile();

    textExtractionQueue = module.get(TextExtractionQueue);
  });

  it('deduplicates active jobs within one storage lifecycle', async () => {
    await textExtractionQueue.enqueue(JOB_DATA);

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

  it('hard-fails only an invoice claimed by UPLOADED or EXTRACTING_TEXT', async () => {
    stateMachine.failIrrecoverably.mockResolvedValue('claimed');
    const failed: FailedStageJob = {
      name: 'extract',
      data: JOB_DATA,
      failedReason: '',
      attemptsMade: 0,
    };

    await textExtractionQueue.finalizeFailure(
      failed,
      new Error('disk unavailable'),
    );

    expect(textExtractionQueue.inFlightStatuses).toEqual([
      InvoiceStatus.UPLOADED,
      InvoiceStatus.EXTRACTING_TEXT,
    ]);
    expect(stateMachine.failIrrecoverably).toHaveBeenCalledWith({
      invoiceId: JOB_DATA.invoiceId,
      storageKey: JOB_DATA.storageKey,
      from: textExtractionQueue.inFlightStatuses,
      failure: TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
    });
    expect(dlq.add).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ failureReason: 'disk unavailable' }),
      expect.anything(),
    );
  });

  it('reopens a dead-lettered lifecycle back to EXTRACTING_TEXT', async () => {
    const dlqJob = {
      name: 'extract',
      data: {
        ...JOB_DATA,
        failedAt: '2026-08-10T12:00:00.000Z',
        failureReason: 'x',
      },
      remove: jest.fn(),
    };
    dlq.getJob.mockResolvedValue(dlqJob);
    stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

    await textExtractionQueue.retryFromDlq(JOB_DATA.invoiceId);

    expect(stateMachine.reopenAfterDeadLetter).toHaveBeenCalledWith({
      ...JOB_DATA,
      to: InvoiceStatus.EXTRACTING_TEXT,
    });
  });
});
