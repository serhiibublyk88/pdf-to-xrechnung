import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, Prisma, SourceType } from '@prisma/client';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import type { PipelineStageQueueConfig } from '../queue/pipeline-stage-queue';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import {
  DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  DataExtractionJobData,
  DataExtractionQueue,
} from './data-extraction-queue.service';
import { DataExtractionProcessor } from './data-extraction.processor';
import { ExtractionAttemptRunner } from './extraction-attempt.runner';
import {
  LLM_PROVIDER,
  LlmStatusError,
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
} from './llm-provider.interface';
import type { LlmProvider } from './llm-provider.interface';
import {
  VALIDATION_RETRY_EXHAUSTED_FAILURE,
  ValidationQueue,
} from '../validation/validation-queue.service';

const JOB_DATA: DataExtractionJobData = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

const PROVIDER: LlmProvider = {
  name: 'mock',
  model: 'mock-v1',
  extract: jest.fn(),
};

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-1',
    ownerId: 'owner-1',
    status: InvoiceStatus.TEXT_READY,
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

function jobFor(
  data: DataExtractionJobData,
  overrides: Partial<Job<DataExtractionJobData>> = {},
): Job<DataExtractionJobData> {
  return {
    data,
    name: 'extract',
    attemptsMade: 0,
    opts: { attempts: 3 },
    failedReason: undefined,
    ...overrides,
  } as Job<DataExtractionJobData>;
}

function emptyParty() {
  return {
    name: null,
    street: null,
    postalCode: null,
    city: null,
    countryCode: null,
    vatId: null,
    taxNumber: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function emptyParsedData() {
  return {
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    deliveryDate: null,
    currency: null,
    seller: emptyParty(),
    buyer: emptyParty(),
    sellerIban: null,
    sellerBic: null,
    lineItems: [],
    netTotal: null,
    vatBreakdown: [],
    vatTotal: null,
    grossTotal: null,
    paymentTerms: null,
    buyerReference: null,
  };
}

function nonEmptyParsedData() {
  return {
    invoiceNumber: 'RE-1',
    issueDate: '2026-01-01',
    dueDate: null,
    deliveryDate: null,
    currency: 'EUR',
    seller: { ...emptyParty(), name: 'Seller' },
    buyer: emptyParty(),
    sellerIban: null,
    sellerBic: null,
    lineItems: [],
    netTotal: null,
    vatBreakdown: [],
    vatTotal: null,
    grossTotal: null,
    paymentTerms: null,
    buyerReference: null,
  };
}

describe('DataExtractionProcessor', () => {
  let processor: DataExtractionProcessor;
  let prisma: {
    invoice: { findUnique: jest.Mock };
    extractionAttempt: { findFirst: jest.Mock };
  };
  let stateMachine: { transition: jest.Mock; failIrrecoverably: jest.Mock };
  let dataExtractionQueue: {
    moveToDlq: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let validationQueue: {
    enqueue: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let runner: { run: jest.Mock };
  let stageLogger: { error: jest.Mock; info: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    stageLogger = { error: jest.fn(), info: jest.fn(), setContext: jest.fn() };

    prisma = {
      invoice: { findUnique: jest.fn() },
      extractionAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    stateMachine = {
      transition: jest.fn().mockResolvedValue('claimed'),
      failIrrecoverably: jest.fn().mockResolvedValue('claimed'),
    };
    dataExtractionQueue = {
      config: {
        stage: PipelineStage.DATA_EXTRACTION,
        claimFrom: InvoiceStatus.TEXT_READY,
        claimTo: InvoiceStatus.EXTRACTING_DATA,
        retryExhaustedFailure: DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_DATA,
      },
      moveToDlq: jest.fn().mockResolvedValue(undefined),
    };
    validationQueue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      config: {
        stage: PipelineStage.VALIDATION,
        claimFrom: InvoiceStatus.DATA_READY,
        claimTo: InvoiceStatus.VALIDATING,
        retryExhaustedFailure: VALIDATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.VALIDATING,
      },
    };
    runner = { run: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExtractionProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: DataExtractionQueue, useValue: dataExtractionQueue },
        { provide: ValidationQueue, useValue: validationQueue },
        { provide: ExtractionAttemptRunner, useValue: runner },
        { provide: LLM_PROVIDER, useValue: PROVIDER },
        { provide: PinoLogger, useValue: stageLogger },
      ],
    }).compile();

    processor = module.get(DataExtractionProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('transitions TEXT_READY to EXTRACTING_DATA before running extraction', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: nonEmptyParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(1, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.TEXT_READY,
      to: InvoiceStatus.EXTRACTING_DATA,
    });
    expect(runner.run).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'Rechnung Nr. RE-1',
    });
  });

  it('transitions to DATA_READY on a non-empty result, without touching ExtractionAttempt itself', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: nonEmptyParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.DATA_READY,
    });
  });

  it('rolls back to EXTRACTING_DATA and rethrows when the validation enqueue is rejected', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: nonEmptyParsedData(),
    });
    const enqueueError = new Error('redis unavailable');
    validationQueue.enqueue.mockRejectedValue(enqueueError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'redis unavailable',
    );

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.DATA_READY,
      to: InvoiceStatus.EXTRACTING_DATA,
    });
  });

  it('does not rethrow when the rollback loses to a validation job that already claimed the lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: nonEmptyParsedData(),
    });
    validationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));
    stateMachine.transition.mockImplementation(
      ({ to }: { to: InvoiceStatus }) =>
        Promise.resolve(
          to === InvoiceStatus.EXTRACTING_DATA ? 'lost' : 'claimed',
        ),
    );

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });

  it('fails deterministically, with a fixed reason, when the extraction is schema-valid but entirely empty', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: emptyParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: {
        failure: { code: 'llm_no_usable_data' },
      },
    });
  });

  it('fails with a fixed reason on a JSON parse failure, never echoing provider text', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({ status: 'failed', failureKind: 'json' });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: {
        failure: { code: 'llm_response_not_json' },
      },
    });
  });

  it('fails with a fixed reason on a schema violation, never echoing provider text', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({ status: 'failed', failureKind: 'schema' });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: {
        failure: { code: 'llm_response_schema_mismatch' },
      },
    });
  });

  it('fails with a fixed reason when the response was truncated, never echoing provider text', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'failed',
      failureKind: 'truncated',
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: {
        failure: { code: 'llm_response_truncated' },
      },
    });
  });

  it('treats a stale runner outcome as a no-op: no transition, no retry, no repair history written', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({ status: 'stale' });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: InvoiceStatus.FAILED }),
    );
    expect(stateMachine.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: InvoiceStatus.DATA_READY }),
    );
  });

  describe('extraction-attempt reuse', () => {
    it('reuses an existing successful attempt instead of calling the provider again', async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
      );
      prisma.extractionAttempt.findFirst.mockResolvedValue({
        id: 'attempt-1',
        attemptNumber: 1,
        parsedData: nonEmptyParsedData(),
      });

      await processor.process(jobFor(JOB_DATA));

      expect(runner.run).not.toHaveBeenCalled();
      expect(prisma.extractionAttempt.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            invoiceId: 'invoice-1',
            storageKey: 'storage-key-1',
          }) as object,
        }),
      );
      expect(stateMachine.transition).toHaveBeenCalledWith({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_DATA,
        to: InvoiceStatus.DATA_READY,
      });
    });

    it('fails instead of reusing an attempt whose stored data is schema-valid but empty', async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
      );
      prisma.extractionAttempt.findFirst.mockResolvedValue({
        id: 'attempt-1',
        attemptNumber: 1,
        parsedData: emptyParsedData(),
      });

      await processor.process(jobFor(JOB_DATA));

      expect(runner.run).not.toHaveBeenCalled();
      expect(stateMachine.transition).toHaveBeenCalledWith({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_DATA,
        to: InvoiceStatus.FAILED,
        data: {
          failure: { code: 'llm_no_usable_data' },
        },
      });
    });

    it('runs a fresh extraction when the stored attempt no longer matches the current schema', async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
      );
      prisma.extractionAttempt.findFirst.mockResolvedValue({
        id: 'attempt-1',
        attemptNumber: 1,
        parsedData: { invoiceNumber: 123 },
      });
      runner.run.mockResolvedValue({
        status: 'parsed',
        data: nonEmptyParsedData(),
      });

      await processor.process(jobFor(JOB_DATA));

      expect(runner.run).toHaveBeenCalledWith({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        invoiceText: 'Rechnung Nr. RE-1',
      });
      expect(stateMachine.transition).toHaveBeenLastCalledWith({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_DATA,
        to: InvoiceStatus.DATA_READY,
      });
    });
  });

  it('propagates a retryable provider error without transitioning the invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockRejectedValue(new RetryableLlmProviderError('timeout'));

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toBeInstanceOf(
      RetryableLlmProviderError,
    );

    expect(stateMachine.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: InvoiceStatus.FAILED }),
    );
  });

  it('fails deterministically on a proven non-retryable provider error, with a fixed reason and no retry budget spent', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockRejectedValue(
      new NonRetryableLlmProviderError('deterministic provider failure'),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'llm_provider_error' } },
    });
  });

  it('passes a non-retryable provider error to the structured logger', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    const providerError = new NonRetryableLlmProviderError(
      'JSON.stringify(errorBody): invoice line item "Consulting for Project Phoenix"',
    );
    runner.run.mockRejectedValue(providerError);

    await processor.process(jobFor(JOB_DATA));

    expect(stageLogger.error).toHaveBeenCalledWith(
      { err: providerError, invoiceId: 'invoice-1' },
      'Data extraction failed',
    );
  });

  it('propagates an unproven runner error (e.g. a PostgreSQL persistence failure) without a terminal transition or a retry-budget spend', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    const persistenceFailure = new Prisma.PrismaClientInitializationError(
      'Cannot reach database server',
      '7.9.1',
      'P1001',
    );
    runner.run.mockRejectedValue(persistenceFailure);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toBe(
      persistenceFailure,
    );

    expect(stateMachine.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: InvoiceStatus.FAILED }),
    );
  });

  it('never logs an unproven runner error message', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        'Cannot reach database server',
        '7.9.1',
        'P1001',
      ),
    );

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow();

    expect(stageLogger.error).not.toHaveBeenCalled();
  });

  it('names the HTTP status of a provider status failure in the log', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    const statusError = new LlmStatusError(
      'Groq request failed with status 413',
      413,
    );
    runner.run.mockRejectedValue(statusError);

    await processor.process(jobFor(JOB_DATA));

    expect(stageLogger.error).toHaveBeenCalledWith(
      { err: statusError, invoiceId: 'invoice-1' },
      'Data extraction failed',
    );
  });

  it('hands a failed attempt to the queue to finalize, then returns the original error to BullMQ', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    const providerError = new RetryableLlmProviderError('timeout');
    runner.run.mockRejectedValue(providerError);
    const job = jobFor(JOB_DATA, { attemptsMade: 2 });

    await expect(processor.process(job)).rejects.toThrow('timeout');
  });

  it('treats a lost lifecycle claim as stale work instead of spending a retry on it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    stateMachine.transition.mockResolvedValue('lost');

    await processor.process(jobFor(JOB_DATA));

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('does not enqueue validation when the DATA_READY completion loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: nonEmptyParsedData(),
    });
    stateMachine.transition.mockImplementation(
      ({ to }: { to: InvoiceStatus }) =>
        Promise.resolve(to === InvoiceStatus.DATA_READY ? 'lost' : 'claimed'),
    );

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();

    expect(validationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('does not throw when a failure transition loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA }),
    );
    runner.run.mockResolvedValue({
      status: 'parsed',
      data: emptyParsedData(),
    });
    stateMachine.transition.mockResolvedValue('lost');

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });

  it('skips a stale job whose invoice already moved past this stage', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.DATA_READY }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('skips a job for an expired lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  it('claims, then fails deterministically, an invoice with no extracted text on record', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ extractedText: null }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(1, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.TEXT_READY,
      to: InvoiceStatus.EXTRACTING_DATA,
    });
    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'llm_no_usable_data' } },
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('claims, then fails deterministically, an already-claimed invoice whose extracted text is an empty string', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_DATA, extractedText: '' }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'llm_no_usable_data' } },
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('moves an already-exhausted lifecycle straight to the dead-letter queue', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({
        status: InvoiceStatus.FAILED,
        failureCode: DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE.code,
      }),
    );
    const job = jobFor(JOB_DATA, { failedReason: 'provider unavailable' });

    await processor.process(job);

    expect(dataExtractionQueue.moveToDlq).toHaveBeenCalledWith(
      job,
      'provider unavailable',
    );
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });
});
