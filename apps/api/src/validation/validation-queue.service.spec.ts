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
  VALIDATION_RETRY_EXHAUSTED_FAILURE,
  ValidationQueue,
} from './validation-queue.service';

const JOB_DATA = { invoiceId: 'invoice-1', storageKey: 'storage-key-1' };

describe('ValidationQueue', () => {
  let validationQueue: ValidationQueue;
  let queue: { add: jest.Mock; getJobs: jest.Mock; getJob: jest.Mock };
  let dlq: { add: jest.Mock; getJob: jest.Mock };
  let stateMachine: {
    reopenAfterDeadLetter: jest.Mock;
    failIrrecoverably: jest.Mock;
  };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationQueue,
        {
          provide: getQueueToken(PipelineStage.VALIDATION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
          useValue: dlq,
        },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        {
          provide: PrismaService,
          useValue: {
            invoice: {
              findUnique: jest
                .fn()
                .mockResolvedValue({ storageKey: JOB_DATA.storageKey }),
            },
          },
        },
        { provide: ConfigService, useValue: { get: () => 2 } },
        {
          provide: PinoLogger,
          useValue: { error: jest.fn(), setContext: jest.fn() },
        },
      ],
    }).compile();

    validationQueue = module.get(ValidationQueue);
  });

  it('deduplicates a validation job within the invoice storage lifecycle', async () => {
    await validationQueue.enqueue(JOB_DATA);

    expect(queue.add).toHaveBeenCalledWith(
      PipelineStage.VALIDATION,
      JOB_DATA,
      expect.objectContaining({
        jobId: lifecycleJobIdFor(
          PipelineStage.VALIDATION,
          JOB_DATA.invoiceId,
          JOB_DATA.storageKey,
        ),
      }),
    );
  });

  it('hard-fails only an invoice already claimed by the validation stage', async () => {
    stateMachine.failIrrecoverably.mockResolvedValue('lost');
    const failed: FailedStageJob = {
      name: 'extract',
      data: JOB_DATA,
      failedReason: '',
      attemptsMade: 0,
    };

    await validationQueue.finalizeFailure(
      failed,
      new Error('database unavailable'),
    );

    expect(stateMachine.failIrrecoverably).toHaveBeenCalledWith({
      invoiceId: JOB_DATA.invoiceId,
      storageKey: JOB_DATA.storageKey,
      from: validationQueue.inFlightStatuses,
      failure: VALIDATION_RETRY_EXHAUSTED_FAILURE,
    });
    expect(validationQueue.inFlightStatuses).toEqual([
      InvoiceStatus.DATA_READY,
      InvoiceStatus.VALIDATING,
    ]);
  });

  it('reopens a dead-lettered lifecycle back to VALIDATING', async () => {
    const dlqJob = {
      name: 'validate',
      data: {
        ...JOB_DATA,
        failedAt: '2026-08-10T12:00:00.000Z',
        failureReason: 'x',
      },
      remove: jest.fn(),
    };
    dlq.getJob.mockResolvedValue(dlqJob);
    stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

    await validationQueue.retryFromDlq(JOB_DATA.invoiceId);

    expect(stateMachine.reopenAfterDeadLetter).toHaveBeenCalledWith({
      ...JOB_DATA,
      to: InvoiceStatus.VALIDATING,
    });
  });
});
