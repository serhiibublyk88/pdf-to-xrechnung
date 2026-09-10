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
  DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  DataExtractionQueue,
} from './data-extraction-queue.service';

const JOB_DATA = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

describe('DataExtractionQueue', () => {
  let dataExtractionQueue: DataExtractionQueue;
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
        DataExtractionQueue,
        {
          provide: getQueueToken(PipelineStage.DATA_EXTRACTION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.DATA_EXTRACTION)),
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

    dataExtractionQueue = module.get(DataExtractionQueue);
  });

  it('deduplicates active jobs within one storage lifecycle', async () => {
    await dataExtractionQueue.enqueue(JOB_DATA);

    expect(queue.add).toHaveBeenCalledWith(
      PipelineStage.DATA_EXTRACTION,
      JOB_DATA,
      expect.objectContaining({
        jobId: lifecycleJobIdFor(
          PipelineStage.DATA_EXTRACTION,
          JOB_DATA.invoiceId,
          JOB_DATA.storageKey,
        ),
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnFail: { age: 7200 },
      }),
    );
  });

  it('hard-fails only an invoice claimed by TEXT_READY or EXTRACTING_DATA', async () => {
    stateMachine.failIrrecoverably.mockResolvedValue('claimed');
    const failed: FailedStageJob = {
      name: 'extract',
      data: JOB_DATA,
      failedReason: '',
      attemptsMade: 0,
    };

    await dataExtractionQueue.finalizeFailure(
      failed,
      new Error('provider unavailable'),
    );

    expect(dataExtractionQueue.inFlightStatuses).toEqual([
      InvoiceStatus.TEXT_READY,
      InvoiceStatus.EXTRACTING_DATA,
    ]);
    expect(stateMachine.failIrrecoverably).toHaveBeenCalledWith({
      invoiceId: JOB_DATA.invoiceId,
      storageKey: JOB_DATA.storageKey,
      from: dataExtractionQueue.inFlightStatuses,
      failure: DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
    });
    expect(dlq.add).toHaveBeenCalled();
  });

  it('reopens a dead-lettered lifecycle back to EXTRACTING_DATA', async () => {
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

    await dataExtractionQueue.retryFromDlq(JOB_DATA.invoiceId);

    expect(stateMachine.reopenAfterDeadLetter).toHaveBeenCalledWith({
      ...JOB_DATA,
      to: InvoiceStatus.EXTRACTING_DATA,
    });
  });
});
