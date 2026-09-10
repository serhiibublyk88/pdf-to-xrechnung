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
  GENERATION_RETRY_EXHAUSTED_FAILURE,
  GenerationQueue,
} from './generation-queue.service';

const JOB_DATA = { invoiceId: 'invoice-1', storageKey: 'storage-key-1' };

describe('GenerationQueue', () => {
  let generationQueue: GenerationQueue;
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
        GenerationQueue,
        {
          provide: getQueueToken(PipelineStage.GENERATION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.GENERATION)),
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

    generationQueue = module.get(GenerationQueue);
  });

  it('deduplicates a generation job within the invoice storage lifecycle', async () => {
    await generationQueue.enqueue(JOB_DATA);

    expect(queue.add).toHaveBeenCalledWith(
      PipelineStage.GENERATION,
      JOB_DATA,
      expect.objectContaining({
        jobId: lifecycleJobIdFor(
          PipelineStage.GENERATION,
          JOB_DATA.invoiceId,
          JOB_DATA.storageKey,
        ),
      }),
    );
  });

  it('hard-fails only an invoice already claimed by the generation stage', async () => {
    stateMachine.failIrrecoverably.mockResolvedValue('lost');
    const failed: FailedStageJob = {
      name: 'generation',
      data: JOB_DATA,
      failedReason: '',
      attemptsMade: 0,
    };

    await generationQueue.finalizeFailure(
      failed,
      new Error('KoSIT validator unavailable'),
    );

    expect(stateMachine.failIrrecoverably).toHaveBeenCalledWith({
      invoiceId: JOB_DATA.invoiceId,
      storageKey: JOB_DATA.storageKey,
      from: generationQueue.inFlightStatuses,
      failure: GENERATION_RETRY_EXHAUSTED_FAILURE,
    });
    expect(generationQueue.inFlightStatuses).toEqual([
      InvoiceStatus.GENERATING,
      InvoiceStatus.GENERATING_DOCUMENT,
    ]);
  });

  it('reopens a dead-lettered lifecycle back to GENERATING', async () => {
    const dlqJob = {
      name: 'generation',
      data: {
        ...JOB_DATA,
        failedAt: '2026-08-10T12:00:00.000Z',
        failureReason: 'x',
      },
      remove: jest.fn(),
    };
    dlq.getJob.mockResolvedValue(dlqJob);
    stateMachine.reopenAfterDeadLetter.mockResolvedValue('claimed');

    await generationQueue.retryFromDlq(JOB_DATA.invoiceId);

    expect(stateMachine.reopenAfterDeadLetter).toHaveBeenCalledWith({
      ...JOB_DATA,
      to: InvoiceStatus.GENERATING,
    });
  });
});
