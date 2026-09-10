import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { buildValidRawExtractedInvoiceData } from '../data-extraction/raw-extracted-invoice.fixture';
import {
  GENERATION_RETRY_EXHAUSTED_FAILURE,
  GenerationQueue,
} from '../generation/generation-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import type {
  FailedStageJob,
  PipelineStageQueueConfig,
} from '../queue/pipeline-stage-queue';
import { ValidationProcessor } from './validation.processor';
import {
  VALIDATION_RETRY_EXHAUSTED_FAILURE,
  ValidationQueue,
  type ValidationJobData,
} from './validation-queue.service';

const JOB_DATA: ValidationJobData = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-1',
    ownerId: 'owner-1',
    status: InvoiceStatus.DATA_READY,
    sourceType: SourceType.NATIVE,
    fileHash: 'hash',
    storageKey: 'storage-key-1',
    originalFilename: 'invoice.pdf',
    fileSizeBytes: 100,
    pageCount: 1,
    extractedText: 'Rechnung Nr. RE-1',
    textCharCount: 17,
    reviewedData: null,
    failureCode: null,
    failureParams: null,
    reviewedAt: null,
    reviewVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

const validParsedData = buildValidRawExtractedInvoiceData;

function jobFor(
  data: ValidationJobData,
  overrides: Partial<FailedStageJob> = {},
): FailedStageJob {
  return {
    data,
    name: 'validation',
    failedReason: '',
    attemptsMade: 0,
    ...overrides,
  };
}

describe('ValidationProcessor', () => {
  let processor: ValidationProcessor;
  let prisma: {
    invoice: { findUnique: jest.Mock };
    extractionAttempt: { findFirst: jest.Mock };
  };
  let stateMachine: { transition: jest.Mock; completeValidation: jest.Mock };
  let validationQueue: {
    moveToDlq: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let generationQueue: {
    enqueue: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let stageLogger: { info: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    prisma = {
      invoice: { findUnique: jest.fn() },
      extractionAttempt: { findFirst: jest.fn() },
    };
    stateMachine = {
      transition: jest.fn().mockResolvedValue('claimed'),
      completeValidation: jest.fn().mockResolvedValue('claimed'),
    };
    validationQueue = {
      config: {
        stage: PipelineStage.VALIDATION,
        claimFrom: InvoiceStatus.DATA_READY,
        claimTo: InvoiceStatus.VALIDATING,
        retryExhaustedFailure: VALIDATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.VALIDATING,
      },
      moveToDlq: jest.fn().mockResolvedValue(undefined),
    };
    generationQueue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      config: {
        stage: PipelineStage.GENERATION,
        claimFrom: InvoiceStatus.GENERATING,
        claimTo: InvoiceStatus.GENERATING_DOCUMENT,
        retryExhaustedFailure: GENERATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.GENERATING,
      },
    };
    stageLogger = { info: jest.fn(), setContext: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: ValidationQueue, useValue: validationQueue },
        { provide: GenerationQueue, useValue: generationQueue },
        { provide: PinoLogger, useValue: stageLogger },
      ],
    }).compile();

    processor = module.get(ValidationProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('claims DATA_READY before persisting a passing validation outcome', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.DATA_READY,
      to: InvoiceStatus.VALIDATING,
    });
    expect(stateMachine.completeValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        to: InvoiceStatus.GENERATING,
      }),
    );
    expect(generationQueue.enqueue).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
    });
  });

  it('rolls back to VALIDATING and rethrows when the generation enqueue is rejected', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const enqueueError = new Error('redis unavailable');
    generationQueue.enqueue.mockRejectedValue(enqueueError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'redis unavailable',
    );

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.GENERATING,
      to: InvoiceStatus.VALIDATING,
    });
  });

  it('does not rethrow when the rollback loses to a generation job that already claimed the lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    generationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));
    stateMachine.transition.mockResolvedValue('lost');

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });

  it('routes a corrupted total to NEEDS_REVIEW without spending a retry', async () => {
    const parsedData = validParsedData();
    parsedData.grossTotal = '120.00';
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({ parsedData });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        to: InvoiceStatus.NEEDS_REVIEW,
      }),
    );
    expect(generationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('routes missing or schema-invalid stored data to NEEDS_REVIEW deterministically', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: { invoiceNumber: 123 },
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        to: InvoiceStatus.NEEDS_REVIEW,
        validationResults: [
          expect.objectContaining({
            rule: 'schema.extracted_data',
            passed: false,
          }),
        ],
      }),
    );
  });

  it('treats a lost lifecycle claim as stale work instead of retrying it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    stateMachine.transition.mockResolvedValue('lost');

    await processor.process(jobFor(JOB_DATA));

    expect(prisma.extractionAttempt.findFirst).not.toHaveBeenCalled();
    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
  });

  it('returns a persistence failure to BullMQ so the attempt counts as failed', async () => {
    const persistenceError = new Error('database unavailable');
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    stateMachine.completeValidation.mockRejectedValue(persistenceError);
    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'database unavailable',
    );
  });

  it('rejects with the exact read error when the latest attempt read fails, without completing or enqueueing', async () => {
    const readError = new Error('connection terminated unexpectedly');
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockRejectedValue(readError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toBe(readError);

    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
    expect(generationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a job whose invoice was already deleted', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).not.toHaveBeenCalled();
    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
  });

  it('ignores a job from an earlier storage lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());

    await processor.process(
      jobFor({ invoiceId: 'invoice-1', storageKey: 'old-storage-key' }),
    );

    expect(stateMachine.transition).not.toHaveBeenCalled();
    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
  });

  it('does not process an expired invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).not.toHaveBeenCalled();
    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
  });

  it('moves an already-exhausted lifecycle straight to the dead-letter queue', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({
        status: InvoiceStatus.FAILED,
        failureCode: VALIDATION_RETRY_EXHAUSTED_FAILURE.code,
      }),
    );
    const job = jobFor(JOB_DATA, { failedReason: 'database unavailable' });

    await processor.process(job);

    expect(validationQueue.moveToDlq).toHaveBeenCalledWith(
      job,
      'database unavailable',
    );
    expect(stateMachine.completeValidation).not.toHaveBeenCalled();
  });

  it('does not throw or dead-letter when validation completion loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.VALIDATING }),
    );
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    stateMachine.completeValidation.mockResolvedValue('lost');

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();

    expect(generationQueue.enqueue).not.toHaveBeenCalled();
  });
});
