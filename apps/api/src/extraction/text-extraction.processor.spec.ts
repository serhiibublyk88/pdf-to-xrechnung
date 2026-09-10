import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import {
  DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  DataExtractionQueue,
} from '../data-extraction/data-extraction-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import type { PipelineStageQueueConfig } from '../queue/pipeline-stage-queue';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import {
  TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  TextExtractionJobData,
  TextExtractionQueue,
} from './text-extraction-queue.service';
import { TextExtractionProcessor } from './text-extraction.processor';
import {
  PdfResourceLimitError,
  RetryableTextExtractionError,
  TextTooLongError,
  TEXT_EXTRACTOR,
  TooManyPagesError,
} from './text-extractor.interface';
import type { TextExtractor } from './text-extractor.interface';
import { OcrTextExtractor } from './ocr-text-extractor';

const PDF_BUFFER = Buffer.from('%PDF-1.4\n%mock invoice content%%EOF');
const JOB_DATA: TextExtractionJobData = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

const DEFAULT_ENV = {
  NATIVE_TEXT_MIN_CHARS_PER_PAGE: 50,
  OCR_MIN_CHARS_PER_PAGE: 50,
  OCR_MIN_MEAN_CONFIDENCE: 80,
  MAX_PAGES: 30,
  MAX_EXTRACTED_TEXT_CHARS: 1000,
};

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-1',
    ownerId: 'owner-1',
    status: InvoiceStatus.UPLOADED,
    sourceType: SourceType.UNKNOWN,
    fileHash: 'hash',
    storageKey: 'storage-key-1',
    originalFilename: 'invoice.pdf',
    fileSizeBytes: PDF_BUFFER.length,
    pageCount: null,
    extractedText: null,
    textCharCount: null,
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
  data: TextExtractionJobData,
  overrides: Partial<Job<TextExtractionJobData>> = {},
): Job<TextExtractionJobData> {
  return {
    data,
    name: 'extract',
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<TextExtractionJobData>;
}

describe('TextExtractionProcessor', () => {
  let processor: TextExtractionProcessor;
  let prisma: {
    invoice: { findUnique: jest.Mock };
  };
  let storage: jest.Mocked<StorageService>;
  let textExtractor: jest.Mocked<TextExtractor>;
  let ocrTextExtractor: jest.Mocked<Pick<OcrTextExtractor, 'extract'>>;
  let stateMachine: { transition: jest.Mock; failIrrecoverably: jest.Mock };
  let textExtractionQueue: {
    moveToDlq: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let dataExtractionQueue: {
    enqueue: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let stageLogger: { error: jest.Mock; info: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    stageLogger = { error: jest.fn(), info: jest.fn(), setContext: jest.fn() };
    prisma = { invoice: { findUnique: jest.fn() } };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
    };
    textExtractor = { extract: jest.fn() };
    ocrTextExtractor = { extract: jest.fn() };
    stateMachine = {
      transition: jest.fn().mockResolvedValue('claimed'),
      failIrrecoverably: jest.fn().mockResolvedValue('claimed'),
    };
    textExtractionQueue = {
      config: {
        stage: PipelineStage.TEXT_EXTRACTION,
        claimFrom: InvoiceStatus.UPLOADED,
        claimTo: InvoiceStatus.EXTRACTING_TEXT,
        retryExhaustedFailure: TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_TEXT,
      },
      moveToDlq: jest.fn().mockResolvedValue(undefined),
    };
    dataExtractionQueue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      config: {
        stage: PipelineStage.DATA_EXTRACTION,
        claimFrom: InvoiceStatus.TEXT_READY,
        claimTo: InvoiceStatus.EXTRACTING_DATA,
        retryExhaustedFailure: DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_DATA,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TextExtractionProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: TextExtractionQueue, useValue: textExtractionQueue },
        { provide: DataExtractionQueue, useValue: dataExtractionQueue },
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof typeof DEFAULT_ENV) => DEFAULT_ENV[key],
          },
        },
        { provide: TEXT_EXTRACTOR, useValue: textExtractor },
        { provide: OcrTextExtractor, useValue: ocrTextExtractor },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: PinoLogger, useValue: stageLogger },
      ],
    }).compile();

    processor = module.get(TextExtractionProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('transitions a fresh invoice to EXTRACTING_TEXT before reading the file', async () => {
    storage.read.mockResolvedValue(PDF_BUFFER);
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    textExtractor.extract.mockResolvedValue({
      text: 'Rechnung Nr. 123',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100 }],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(1, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.UPLOADED,
      to: InvoiceStatus.EXTRACTING_TEXT,
    });
    expect(storage.read).toHaveBeenCalledWith('storage-key-1');
    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: {
        sourceType: SourceType.NATIVE,
        pageCount: 1,
        extractedText: 'Rechnung Nr. 123',
        textCharCount: 100,
      },
    });
    expect(dataExtractionQueue.enqueue).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
    });
  });

  it('rolls back to EXTRACTING_TEXT and rethrows when the data-extraction enqueue is rejected', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: 'Rechnung Nr. 123',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100 }],
    });
    const enqueueError = new Error('redis unavailable');
    dataExtractionQueue.enqueue.mockRejectedValue(enqueueError);

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'redis unavailable',
    );

    expect(stateMachine.transition).toHaveBeenLastCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.TEXT_READY,
      to: InvoiceStatus.EXTRACTING_TEXT,
    });
  });

  it('does not rethrow when the rollback loses to a data-extraction job that already claimed the lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_TEXT }),
    );
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: 'Rechnung Nr. 123',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100 }],
    });
    dataExtractionQueue.enqueue.mockRejectedValue(
      new Error('redis unavailable'),
    );
    stateMachine.transition.mockImplementation(
      ({ to }: { to: InvoiceStatus }) =>
        Promise.resolve(
          to === InvoiceStatus.EXTRACTING_TEXT ? 'lost' : 'claimed',
        ),
    );

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });

  it('does not enqueue data extraction when the invoice fails before TEXT_READY', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockRejectedValue(new Error('disk unavailable'));

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'disk unavailable',
    );

    expect(dataExtractionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('treats a lost lifecycle claim as stale work instead of spending a retry on it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    stateMachine.transition.mockResolvedValue('lost');

    await processor.process(jobFor(JOB_DATA));

    expect(storage.read).not.toHaveBeenCalled();
  });

  it('does not enqueue data extraction when the TEXT_READY completion loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_TEXT }),
    );
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: 'Rechnung Nr. 123',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100 }],
    });
    stateMachine.transition.mockImplementation(
      ({ to }: { to: InvoiceStatus }) =>
        Promise.resolve(to === InvoiceStatus.TEXT_READY ? 'lost' : 'claimed'),
    );

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();

    expect(dataExtractionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('does not throw when a failure transition loses its lifecycle claim', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_TEXT }),
    );
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '',
      pageCount: 0,
      charCount: 0,
      pages: [],
    });
    stateMachine.transition.mockResolvedValue('lost');

    await expect(processor.process(jobFor(JOB_DATA))).resolves.toBeUndefined();
  });

  it('resumes a retried job from EXTRACTING_TEXT without repeating the first transition', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ status: InvoiceStatus.EXTRACTING_TEXT }),
    );
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: 'Rechnung Nr. 123',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100 }],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenCalledTimes(1);
    expect(stateMachine.transition).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: expect.any(Object) as object,
    });
  });

  const NON_OWNED_STATUSES = Object.values(InvoiceStatus).filter(
    (status) =>
      status !== InvoiceStatus.UPLOADED &&
      status !== InvoiceStatus.EXTRACTING_TEXT,
  );

  it.each(NON_OWNED_STATUSES)(
    'no-ops for a stale/duplicate job on an invoice already %s, whether that status predates or postdates this stage',
    async (status) => {
      prisma.invoice.findUnique.mockResolvedValue(baseInvoice({ status }));

      await processor.process(jobFor(JOB_DATA));

      expect(storage.read).not.toHaveBeenCalled();
      expect(stateMachine.transition).not.toHaveBeenCalled();
    },
  );

  it('ignores a job from an earlier storage lifecycle', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());

    await processor.process(
      jobFor({ invoiceId: 'invoice-1', storageKey: 'old-storage-key' }),
    );

    expect(storage.read).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  it('ignores a job whose invoice was already deleted', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);

    await processor.process(jobFor(JOB_DATA));

    expect(storage.read).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  it('does not process an expired invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(storage.read).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  it('lets a storage read failure propagate so BullMQ retries it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockRejectedValue(new Error('disk unavailable'));

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'disk unavailable',
    );
    expect(stateMachine.transition).toHaveBeenCalledTimes(1);
    expect(stateMachine.failIrrecoverably).not.toHaveBeenCalled();
    expect(textExtractionQueue.moveToDlq).not.toHaveBeenCalled();
  });

  it('fails a corrupt PDF outright instead of retrying a deterministic parse error', async () => {
    const parseError = new Error('bad xref table');
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockRejectedValue(parseError);

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: {
        failure: { code: 'pdf_unreadable' },
      },
    });
    expect(stageLogger.error).toHaveBeenCalledWith(
      { err: parseError, invoiceId: 'invoice-1' },
      'Text extraction failed',
    );
  });

  it('propagates an extraction timeout so BullMQ can retry it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockRejectedValue(
      new RetryableTextExtractionError('worker timed out'),
    );

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'worker timed out',
    );
    expect(stateMachine.transition).toHaveBeenCalledTimes(1);
    expect(stateMachine.failIrrecoverably).not.toHaveBeenCalled();
  });

  it('fails a native resource limit without retrying or logging document data', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockRejectedValue(
      new PdfResourceLimitError('PDF resource limit exceeded'),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'pdf_resource_limit' } },
    });
    expect(stageLogger.error).not.toHaveBeenCalled();
  });

  it('keeps the native worker character limit distinct from an unreadable PDF', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockRejectedValue(
      new TextTooLongError(
        DEFAULT_ENV.MAX_EXTRACTED_TEXT_CHARS + 1,
        DEFAULT_ENV.MAX_EXTRACTED_TEXT_CHARS,
      ),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: {
        failure: {
          code: 'text_too_long',
          params: {
            charCount: DEFAULT_ENV.MAX_EXTRACTED_TEXT_CHARS + 1,
            limit: DEFAULT_ENV.MAX_EXTRACTED_TEXT_CHARS,
          },
        },
      },
    });
    expect(stageLogger.error).not.toHaveBeenCalled();
  });

  it('fails a zero-page PDF instead of dividing by zero into a false pass', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '',
      pageCount: 0,
      charCount: 0,
      pages: [],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'pdf_no_pages' } },
    });
  });

  it('fails a PDF over the configured page limit without ever calling the OCR fallback', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockRejectedValue(
      new TooManyPagesError(DEFAULT_ENV.MAX_PAGES + 1, DEFAULT_ENV.MAX_PAGES),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: {
        pageCount: DEFAULT_ENV.MAX_PAGES + 1,
        failure: {
          code: 'pdf_too_many_pages',
          params: {
            pageCount: DEFAULT_ENV.MAX_PAGES + 1,
            limit: DEFAULT_ENV.MAX_PAGES,
          },
        },
      },
    });
    expect(ocrTextExtractor.extract).not.toHaveBeenCalled();
  });

  it('routes a fully scanned PDF through OCR and continues with OCR text', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n \n--- PAGE 2 ---\n ',
      pageCount: 2,
      charCount: 10,
      pages: [
        { pageNumber: 1, charCount: 5 },
        { pageNumber: 2, charCount: 5 },
      ],
    });
    ocrTextExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\nRechnung 1\n\n--- PAGE 2 ---\nGesamtbetrag 100 EUR',
      pageCount: 2,
      charCount: 200,
      pages: [
        { pageNumber: 1, charCount: 100, meanConfidence: 92 },
        { pageNumber: 2, charCount: 100, meanConfidence: 91 },
      ],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(ocrTextExtractor.extract).toHaveBeenCalledWith(PDF_BUFFER, 2);
    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: {
        sourceType: SourceType.OCR,
        pageCount: 2,
        extractedText:
          '--- PAGE 1 ---\nRechnung 1\n\n--- PAGE 2 ---\nGesamtbetrag 100 EUR',
        textCharCount: 200,
      },
    });
  });

  it('keeps a native document with one sparse page on its native text', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\nRechnungsnummer RE-2026-001\n\n--- PAGE 2 ---\n ',
      pageCount: 2,
      charCount: 205,
      pages: [
        { pageNumber: 1, charCount: 200 },
        { pageNumber: 2, charCount: 5 },
      ],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(ocrTextExtractor.extract).not.toHaveBeenCalled();
    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: expect.objectContaining({
        sourceType: SourceType.NATIVE,
      }) as object,
    });
  });

  it('keeps a scanned two-page document usable when only its blank page is sparse after OCR', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n\n--- PAGE 2 ---\n',
      pageCount: 2,
      charCount: 0,
      pages: [
        { pageNumber: 1, charCount: 0 },
        { pageNumber: 2, charCount: 0 },
      ],
    });
    ocrTextExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\nRechnung 1\n\n--- PAGE 2 ---\n',
      pageCount: 2,
      charCount: 100,
      pages: [
        { pageNumber: 1, charCount: 100, meanConfidence: 92 },
        { pageNumber: 2, charCount: 0, meanConfidence: 0 },
      ],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: {
        sourceType: SourceType.OCR,
        pageCount: 2,
        extractedText: '--- PAGE 1 ---\nRechnung 1\n\n--- PAGE 2 ---\n',
        textCharCount: 100,
      },
    });
  });

  it('fails OCR when every page is below the character threshold', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n\n--- PAGE 2 ---\n',
      pageCount: 2,
      charCount: 0,
      pages: [
        { pageNumber: 1, charCount: 0 },
        { pageNumber: 2, charCount: 0 },
      ],
    });
    ocrTextExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n\n--- PAGE 2 ---\n',
      pageCount: 2,
      charCount: 0,
      pages: [
        { pageNumber: 1, charCount: 0, meanConfidence: 0 },
        { pageNumber: 2, charCount: 0, meanConfidence: 0 },
      ],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: {
        sourceType: SourceType.OCR,
        pageCount: 2,
        textCharCount: 0,
        failure: {
          code: 'ocr_text_too_sparse',
          params: { pages: [1, 2] },
        },
      },
    });
  });

  it('fails OCR whose lowest page confidence is below the configured minimum', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n ',
      pageCount: 1,
      charCount: 1,
      pages: [{ pageNumber: 1, charCount: 1 }],
    });
    ocrTextExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\nRechnung 1',
      pageCount: 1,
      charCount: 100,
      pages: [{ pageNumber: 1, charCount: 100, meanConfidence: 79 }],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: {
        sourceType: SourceType.OCR,
        pageCount: 1,
        textCharCount: 100,
        failure: {
          code: 'ocr_confidence_too_low',
          params: { lowestPageConfidence: 79, minimum: 80 },
        },
      },
    });
  });

  it('fails deterministically, without spending a retry, when OCR rejects the document itself', async () => {
    const commandError = new Error('OCR command pdftocairo exited with code 2');
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n ',
      pageCount: 1,
      charCount: 1,
      pages: [{ pageNumber: 1, charCount: 1 }],
    });
    ocrTextExtractor.extract.mockRejectedValue(commandError);

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'pdf_unreadable' } },
    });
    expect(stageLogger.error).toHaveBeenCalledWith(
      { err: commandError, invoiceId: 'invoice-1' },
      'OCR extraction failed',
    );
  });

  it('propagates a retryable OCR failure so BullMQ can retry it', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n ',
      pageCount: 1,
      charCount: 1,
      pages: [{ pageNumber: 1, charCount: 1 }],
    });
    ocrTextExtractor.extract.mockRejectedValue(
      new RetryableTextExtractionError(
        'OCR extraction exceeded its time limit',
      ),
    );

    await expect(processor.process(jobFor(JOB_DATA))).rejects.toThrow(
      'OCR extraction exceeded its time limit',
    );
    expect(stateMachine.transition).toHaveBeenCalledTimes(1);
    expect(stateMachine.failIrrecoverably).not.toHaveBeenCalled();
  });

  it('fails an OCR resource limit without retrying or logging document data', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    textExtractor.extract.mockResolvedValue({
      text: '--- PAGE 1 ---\n ',
      pageCount: 1,
      charCount: 1,
      pages: [{ pageNumber: 1, charCount: 1 }],
    });
    ocrTextExtractor.extract.mockRejectedValue(
      new PdfResourceLimitError('PDF resource limit exceeded'),
    );

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'pdf_resource_limit' } },
    });
    expect(stageLogger.error).not.toHaveBeenCalled();
  });

  it('fails when extracted text exceeds the configured character ceiling', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    storage.read.mockResolvedValue(PDF_BUFFER);
    const overLimitCharCount = DEFAULT_ENV.MAX_EXTRACTED_TEXT_CHARS + 1;
    textExtractor.extract.mockResolvedValue({
      text: 'x'.repeat(overLimitCharCount),
      pageCount: 1,
      charCount: overLimitCharCount,
      pages: [{ pageNumber: 1, charCount: overLimitCharCount }],
    });

    await processor.process(jobFor(JOB_DATA));

    expect(stateMachine.transition).toHaveBeenNthCalledWith(2, {
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: expect.objectContaining({
        textCharCount: overLimitCharCount,
      }) as object,
    });
  });

  it('hands a failed attempt to the queue to finalize, then returns the original error to BullMQ', async () => {
    prisma.invoice.findUnique.mockResolvedValue(baseInvoice());
    const readError = new Error('disk unavailable');
    storage.read.mockRejectedValue(readError);
    const job = jobFor(JOB_DATA, { attemptsMade: 2 });

    await expect(processor.process(job)).rejects.toThrow('disk unavailable');
  });

  it('finishes a dead-letter write interrupted after the database transition', async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInvoice({
        status: InvoiceStatus.FAILED,
        failureCode: TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE.code,
      }),
    );
    const job = jobFor(JOB_DATA, {
      failedReason: 'disk unavailable',
      attemptsMade: 2,
    });

    await processor.process(job);

    expect(textExtractionQueue.moveToDlq).toHaveBeenCalledWith(
      job,
      'disk unavailable',
    );
    expect(storage.read).not.toHaveBeenCalled();
  });
});
