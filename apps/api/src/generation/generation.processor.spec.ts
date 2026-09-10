import { InvoiceService } from '@e-invoice-eu/core';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, Severity, SourceType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { buildValidRawExtractedInvoiceData } from '../data-extraction/raw-extracted-invoice.fixture';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import type {
  FailedStageJob,
  PipelineStageQueueConfig,
} from '../queue/pipeline-stage-queue';
import {
  GENERATION_RETRY_EXHAUSTED_FAILURE,
  GenerationQueue,
  type GenerationJobData,
} from './generation-queue.service';
import { GenerationProcessor } from './generation.processor';
import { KositClient, RetryableKositError } from './kosit-client';

const JOB_DATA: GenerationJobData = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-1',
    ownerId: 'owner-1',
    status: InvoiceStatus.GENERATING,
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
  data: GenerationJobData,
  overrides: Partial<FailedStageJob> = {},
): FailedStageJob {
  return {
    data,
    name: 'generation',
    failedReason: '',
    attemptsMade: 0,
    ...overrides,
  };
}

describe('GenerationProcessor', () => {
  let processor: GenerationProcessor;
  let prisma: {
    invoice: { findUnique: jest.Mock };
    extractionAttempt: { findFirst: jest.Mock };
  };
  let stateMachine: {
    transition: jest.Mock;
    rejectGeneration: jest.Mock;
    completeGeneration: jest.Mock;
  };
  let generationQueue: {
    moveToDlq: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let kositClient: { validate: jest.Mock };
  let stageLogger: { info: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma = {
      invoice: { findUnique: jest.fn() },
      extractionAttempt: { findFirst: jest.fn() },
    };
    stateMachine = {
      transition: jest.fn().mockResolvedValue('claimed'),
      rejectGeneration: jest.fn().mockResolvedValue('claimed'),
      completeGeneration: jest.fn().mockResolvedValue('claimed'),
    };
    generationQueue = {
      config: {
        stage: PipelineStage.GENERATION,
        claimFrom: InvoiceStatus.GENERATING,
        claimTo: InvoiceStatus.GENERATING_DOCUMENT,
        retryExhaustedFailure: GENERATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.GENERATING,
      },
      moveToDlq: jest.fn().mockResolvedValue(undefined),
    };
    kositClient = {
      validate: jest.fn().mockResolvedValue({
        valid: true,
        reportXml: '<rep:report/>',
        messages: [],
      }),
    };
    stageLogger = { info: jest.fn(), setContext: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenerationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: GenerationQueue, useValue: generationQueue },
        { provide: KositClient, useValue: kositClient },
        { provide: PinoLogger, useValue: stageLogger },
      ],
    }).compile();

    processor = module.get(GenerationProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates and submits a valid invoice, completing to READY', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(kositClient.validate).toHaveBeenCalledWith(expect.any(String));
    expect(stateMachine.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        to: InvoiceStatus.READY,
        document: expect.objectContaining({
          format: 'XRECHNUNG_UBL',
          isValid: true,
        }) as unknown,
      }),
    );
    expect(stateMachine.rejectGeneration).not.toHaveBeenCalled();
  });

  it('claims queued generation before it reads the extracted invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenCalledWith({
      invoiceId: JOB_DATA.invoiceId,
      storageKey: JOB_DATA.storageKey,
      from: InvoiceStatus.GENERATING,
      to: InvoiceStatus.GENERATING_DOCUMENT,
    });
  });

  it('does not read or complete a queued generation job that lost its claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    stateMachine.transition.mockResolvedValue('lost');

    await processor.process(jobFor(JOB_DATA));

    expect(prisma.extractionAttempt.findFirst).not.toHaveBeenCalled();
    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('uses reviewed data instead of the original extraction for regeneration', async () => {
    const reviewedData = validParsedData();
    reviewedData.invoiceNumber = 'CORRECTED-2026-001';
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice({ reviewedData }));
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: { invoiceNumber: 123 },
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.rejectGeneration).not.toHaveBeenCalled();
    expect(kositClient.validate).toHaveBeenCalled();
  });

  it('routes a KoSIT rejection to NEEDS_REVIEW with a finding per rule the validator named', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    kositClient.validate.mockResolvedValue({
      valid: false,
      reportXml: '<rep:report valid="false"/>',
      messages: [
        { code: 'BR-CO-09', level: 'error', text: '[BR-CO-09] bad prefix' },
        { code: 'BR-DE-TMP-32', level: 'information', text: 'a hint' },
      ],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        to: InvoiceStatus.NEEDS_REVIEW,
        findings: [
          {
            rule: 'kosit.BR-CO-09',
            field: null,
            severity: Severity.ERROR,
            passed: false,
            message: '[BR-CO-09] bad prefix',
          },
          {
            rule: 'kosit.BR-DE-TMP-32',
            field: null,
            severity: Severity.INFO,
            passed: false,
            message: 'a hint',
          },
        ],
      }),
    );
  });

  it('still records a finding when a rejection names no rule at all', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    kositClient.validate.mockResolvedValue({
      valid: false,
      reportXml: '<rep:report valid="false"/>',
      messages: [],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        to: InvoiceStatus.NEEDS_REVIEW,
        findings: [
          expect.objectContaining({
            rule: 'kosit.unspecified',
            severity: Severity.ERROR,
          }),
        ],
      }),
    );
  });

  it('records no finding of its own when KoSIT accepts the document', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ to: InvoiceStatus.READY, findings: [] }),
    );
  });

  it('lets a retryable KoSIT failure through to BullMQ instead of routing to review', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const retryableError = new RetryableKositError('validator unreachable');
    kositClient.validate.mockRejectedValue(retryableError);
    const job = jobFor(JOB_DATA);

    await expect(processor.process(job)).rejects.toThrow(retryableError);

    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('routes a rejected mapping to NEEDS_REVIEW without calling KoSIT', async () => {
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.unit = 'Sack';
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({ parsedData });

    await processor.process(jobFor(JOB_DATA));

    expect(kositClient.validate).not.toHaveBeenCalled();
    expect(stateMachine.rejectGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [expect.objectContaining({ rule: 'mapping.line_unit' })],
      }),
    );
  });

  it('routes missing or schema-invalid stored data to NEEDS_REVIEW deterministically', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: { invoiceNumber: 123 },
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.rejectGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [
          expect.objectContaining({ rule: 'mapping.schema', passed: false }),
        ],
      }),
    );
  });

  it('routes an AJV schema rejection from the generator to NEEDS_REVIEW without calling KoSIT', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const schemaError = Object.assign(new Error('validation failed'), {
      errors: [{ instancePath: '/x' }],
    });
    jest
      .spyOn(InvoiceService.prototype, 'generate')
      .mockRejectedValue(schemaError);

    await processor.process(jobFor(JOB_DATA));

    expect(kositClient.validate).not.toHaveBeenCalled();
    expect(stateMachine.rejectGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [
          expect.objectContaining({ rule: 'mapping.generation_failed' }),
        ],
      }),
    );
  });

  it('names the rejected AJV instance paths in the mapping.generation_failed message', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const schemaError = Object.assign(new Error('validation failed'), {
      errors: [
        { instancePath: '/cac:InvoiceLine/0/cbc:InvoicedQuantity@unitCode' },
        { instancePath: '/cbc:DocumentCurrencyCode' },
      ],
    });
    jest
      .spyOn(InvoiceService.prototype, 'generate')
      .mockRejectedValue(schemaError);

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.rejectGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [
          expect.objectContaining({
            rule: 'mapping.generation_failed',
            field: null,
          }),
        ],
      }),
    );
    const [{ findings }] = stateMachine.rejectGeneration.mock.calls[0] as [
      { findings: { message: string }[] },
    ];
    expect(findings[0]?.message).toContain(
      '/cac:InvoiceLine/0/cbc:InvoicedQuantity@unitCode',
    );
    expect(findings[0]?.message).toContain('/cbc:DocumentCurrencyCode');
  });

  it('keeps the generic mapping.generation_failed text when AJV reports no paths', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const schemaError = Object.assign(new Error('validation failed'), {
      errors: [],
    });
    jest
      .spyOn(InvoiceService.prototype, 'generate')
      .mockRejectedValue(schemaError);

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.rejectGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [
          expect.objectContaining({
            rule: 'mapping.generation_failed',
            message:
              'The mapped invoice was rejected by the XRechnung UBL generator.',
          }),
        ],
      }),
    );
  });

  it('rethrows and dead-letters a generator failure that is not an AJV schema rejection', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    const unexpectedError = new Error('boom');
    jest
      .spyOn(InvoiceService.prototype, 'generate')
      .mockRejectedValue(unexpectedError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      unexpectedError,
    );

    expect(stateMachine.rejectGeneration).not.toHaveBeenCalled();
    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('ignores a job whose invoice was already deleted', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);

    await processor.process(jobFor(JOB_DATA));

    expect(prisma.extractionAttempt.findFirst).not.toHaveBeenCalled();
    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('ignores a job from an earlier storage lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());

    await processor.process(
      jobFor({ invoiceId: 'invoice-1', storageKey: 'old-storage-key' }),
    );

    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('does not process an expired invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('moves an already-exhausted lifecycle straight to the dead-letter queue', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({
        status: InvoiceStatus.FAILED,
        failureCode: GENERATION_RETRY_EXHAUSTED_FAILURE.code,
      }),
    );
    const job = jobFor(JOB_DATA, { failedReason: 'KoSIT validator down' });

    await processor.process(job);

    expect(generationQueue.moveToDlq).toHaveBeenCalledWith(
      job,
      'KoSIT validator down',
    );
    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('returns a persistence failure to BullMQ so the attempt counts as failed', async () => {
    const persistenceError = new Error('database unavailable');
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    stateMachine.completeGeneration.mockRejectedValue(persistenceError);
    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'database unavailable',
    );
  });

  it('returns a read failure on the stored extraction attempt to BullMQ instead of routing to review', async () => {
    const readError = new Error('database unavailable');
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockRejectedValue(readError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      readError,
    );

    expect(stateMachine.rejectGeneration).not.toHaveBeenCalled();
    expect(stateMachine.completeGeneration).not.toHaveBeenCalled();
  });

  it('does not throw or dead-letter when generation completion loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    prisma.extractionAttempt.findFirst.mockResolvedValue({
      parsedData: validParsedData(),
    });
    stateMachine.completeGeneration.mockResolvedValue('lost');

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });
});
