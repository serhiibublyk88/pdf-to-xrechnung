import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, Prisma, SourceType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { TextExtractionQueue } from '../extraction/text-extraction-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { InvoicesService } from './invoices.service';

const PDF_BUFFER = Buffer.from('%PDF-1.4\n%mock invoice content%%EOF');

const RETENTION_HOURS = 2;

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: { modelName: 'Invoice' },
  });
}

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

describe('InvoicesService', () => {
  let service: InvoicesService;
  let tx: {
    invoice: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    extractionAttempt: { deleteMany: jest.Mock };
    validationResult: { deleteMany: jest.Mock };
    generatedDocument: { deleteMany: jest.Mock };
  };
  let prisma: {
    invoice: { create: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
    generatedDocument: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let storage: jest.Mocked<StorageService>;
  let textExtractionQueue: { enqueue: jest.Mock };
  let logger: { error: jest.Mock; setContext: jest.Mock; warn: jest.Mock };

  async function createService(): Promise<InvoicesService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: () => RETENTION_HOURS },
        },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: TextExtractionQueue, useValue: textExtractionQueue },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    return module.get(InvoicesService);
  }

  const file = {
    buffer: PDF_BUFFER,
    originalname: 'invoice.pdf',
  };

  beforeEach(async () => {
    logger = {
      error: jest.fn(),
      setContext: jest.fn(),
      warn: jest.fn(),
    };
    tx = {
      invoice: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      extractionAttempt: { deleteMany: jest.fn() },
      validationResult: { deleteMany: jest.fn() },
      generatedDocument: { deleteMany: jest.fn() },
    };
    prisma = {
      invoice: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      generatedDocument: { findFirst: jest.fn() },
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
    };
    textExtractionQueue = { enqueue: jest.fn() };

    service = await createService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a file that is not a PDF, without touching storage or the database', async () => {
    const notAPdf = {
      buffer: Buffer.from('not a pdf'),
      originalname: 'invoice.pdf',
    };

    await expect(
      service.ingest({ ownerId: 'owner-1', file: notAPdf }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('accepts a PDF with a few junk bytes before the %PDF- header', async () => {
    const fileWithLeadingJunk = {
      buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF_BUFFER]),
      originalname: 'invoice.pdf',
    };
    prisma.invoice.create.mockResolvedValue(baseInvoice());

    await expect(
      service.ingest({ ownerId: 'owner-1', file: fileWithLeadingJunk }),
    ).resolves.not.toThrow();
  });

  it('stores the file and enqueues text extraction for a fresh upload, without waiting for it', async () => {
    const created = baseInvoice();
    prisma.invoice.create.mockResolvedValue(created);

    const ingestResult = await service.ingest({ ownerId: 'owner-1', file });

    expect(storage.save).toHaveBeenCalledWith(created.storageKey, PDF_BUFFER);
    expect(textExtractionQueue.enqueue).toHaveBeenCalledWith({
      invoiceId: created.id,
      storageKey: created.storageKey,
    });
    expect(ingestResult).toEqual({
      id: created.id,
      status: InvoiceStatus.UPLOADED,
      deduplicated: false,
    });
  });

  it('keeps a storage failure retryable and reports service unavailability', async () => {
    const created = baseInvoice();
    prisma.invoice.create
      .mockResolvedValueOnce(created)
      .mockRejectedValueOnce(uniqueConstraintError());
    prisma.invoice.findUnique.mockResolvedValue(created);
    storage.save
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.ingest({ ownerId: 'owner-1', file }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(textExtractionQueue.enqueue).not.toHaveBeenCalled();

    const retried = await service.ingest({ ownerId: 'owner-1', file });

    expect(storage.save).toHaveBeenLastCalledWith(
      created.storageKey,
      file.buffer,
    );
    expect(textExtractionQueue.enqueue).toHaveBeenCalledWith({
      invoiceId: created.id,
      storageKey: created.storageKey,
    });
    expect(retried).toEqual({
      id: created.id,
      status: InvoiceStatus.UPLOADED,
      deduplicated: true,
    });
  });

  describe('concurrent or repeat uploads of the same bytes by the same owner', () => {
    it('serves the existing invoice as deduplicated instead of creating a second row', async () => {
      prisma.invoice.create.mockRejectedValue(uniqueConstraintError());
      const existing = baseInvoice({
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'already extracted',
      });
      prisma.invoice.findUnique.mockResolvedValue(existing);

      const ingestResult = await service.ingest({
        ownerId: 'owner-1',
        file,
      });

      expect(ingestResult).toEqual({
        id: existing.id,
        status: InvoiceStatus.TEXT_READY,
        deduplicated: true,
      });
      expect(storage.save).not.toHaveBeenCalled();
      expect(textExtractionQueue.enqueue).not.toHaveBeenCalled();
    });

    it('re-saves the file and re-enqueues instead of stranding an invoice that never left UPLOADED', async () => {
      prisma.invoice.create.mockRejectedValue(uniqueConstraintError());
      const existing = baseInvoice({ status: InvoiceStatus.UPLOADED });
      prisma.invoice.findUnique.mockResolvedValue(existing);

      const ingestResult = await service.ingest({
        ownerId: 'owner-1',
        file,
      });

      expect(storage.save).toHaveBeenCalledWith(
        existing.storageKey,
        PDF_BUFFER,
      );
      expect(textExtractionQueue.enqueue).toHaveBeenCalledWith({
        invoiceId: existing.id,
        storageKey: existing.storageKey,
      });
      expect(ingestResult.deduplicated).toBe(true);
    });

    it('reuses a row past its retention window instead of blocking a legitimate re-upload', async () => {
      prisma.invoice.create.mockRejectedValue(uniqueConstraintError());
      const expired = baseInvoice({ expiresAt: new Date(Date.now() - 1000) });
      const refreshed = baseInvoice({
        id: expired.id,
        status: InvoiceStatus.UPLOADED,
        storageKey: 'storage-key-2',
      });
      prisma.invoice.findUnique.mockResolvedValue(expired);
      tx.invoice.updateMany.mockResolvedValue({ count: 1 });
      tx.invoice.findUniqueOrThrow.mockResolvedValue(refreshed);

      const ingestResult = await service.ingest({
        ownerId: 'owner-1',
        file,
      });

      expect(tx.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: expired.id,
          expiresAt: { lte: expect.any(Date) as Date },
        },
        data: expect.objectContaining({
          status: InvoiceStatus.UPLOADED,
          reviewVersion: 0,
          createdAt: expect.any(Date) as Date,
        }) as Partial<Invoice>,
      });
      expect(tx.extractionAttempt.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: expired.id },
      });
      expect(tx.validationResult.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: expired.id },
      });
      expect(tx.generatedDocument.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: expired.id },
      });
      expect(storage.delete).toHaveBeenCalledWith(expired.storageKey);
      expect(storage.save).toHaveBeenCalledWith(
        refreshed.storageKey,
        PDF_BUFFER,
      );
      expect(textExtractionQueue.enqueue).toHaveBeenCalledWith({
        invoiceId: refreshed.id,
        storageKey: refreshed.storageKey,
      });
      expect(ingestResult.deduplicated).toBe(false);
    });

    it('retries as a fresh lookup instead of re-resetting a row a concurrent resurrection already won', async () => {
      prisma.invoice.create.mockRejectedValue(uniqueConstraintError());
      const expired = baseInvoice({ expiresAt: new Date(Date.now() - 1000) });
      const wonByAnotherRequest = baseInvoice({
        id: expired.id,
        status: InvoiceStatus.EXTRACTING_TEXT,
      });
      prisma.invoice.findUnique
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(wonByAnotherRequest);
      tx.invoice.updateMany.mockResolvedValue({ count: 0 });

      const ingestResult = await service.ingest({
        ownerId: 'owner-1',
        file,
      });

      expect(storage.delete).toHaveBeenCalledWith(expired.storageKey);
      expect(tx.extractionAttempt.deleteMany).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
      expect(textExtractionQueue.enqueue).not.toHaveBeenCalled();
      expect(ingestResult.deduplicated).toBe(true);
    });

    it('retries the insert when the row disappears entirely between the failed insert and the dedup read', async () => {
      const created = baseInvoice({ id: 'invoice-2' });
      prisma.invoice.create
        .mockRejectedValueOnce(uniqueConstraintError())
        .mockResolvedValueOnce(created);
      prisma.invoice.findUnique.mockResolvedValueOnce(null);

      const ingestResult = await service.ingest({
        ownerId: 'owner-1',
        file,
      });

      expect(prisma.invoice.create).toHaveBeenCalledTimes(2);
      expect(storage.save).toHaveBeenCalledWith(created.storageKey, PDF_BUFFER);
      expect(ingestResult.deduplicated).toBe(false);
    });

    it('gives up after bounded retries instead of retrying forever when the row never reappears', async () => {
      const conflict = uniqueConstraintError();
      prisma.invoice.create.mockRejectedValue(conflict);
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(service.ingest({ ownerId: 'owner-1', file })).rejects.toBe(
        conflict,
      );
      expect(prisma.invoice.create).toHaveBeenCalledTimes(4);
    });
  });

  describe('findForOwner', () => {
    it('returns the invoice status when it belongs to the requesting owner', async () => {
      const invoice = baseInvoice({
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        pageCount: 2,
      });
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      const statusResult = await service.findForOwner(
        invoice.id,
        invoice.ownerId,
      );

      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: {
          id: invoice.id,
          ownerId: invoice.ownerId,
          expiresAt: { gt: expect.any(Date) as Date },
        },
      });
      expect(statusResult).toEqual({
        id: invoice.id,
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        pageCount: 2,
        failure: null,
      });
    });

    it('returns null instead of leaking that a differently-owned invoice exists', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);

      const statusResult = await service.findForOwner('invoice-1', 'owner-2');

      expect(statusResult).toBeNull();
    });

    it('keeps a failed invoice readable when its stored failure code is unknown', async () => {
      const invoice = baseInvoice({
        status: InvoiceStatus.FAILED,
        failureCode: 'future_failure_code',
      });
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      await expect(
        service.findForOwner(invoice.id, invoice.ownerId),
      ).resolves.toEqual({
        id: invoice.id,
        status: InvoiceStatus.FAILED,
        sourceType: SourceType.UNKNOWN,
        pageCount: null,
        failure: null,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        `Ignoring invalid stored failure data for invoice ${invoice.id}`,
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('future_failure_code'),
      );
    });
  });

  describe('getGeneratedDocument', () => {
    it('returns the XML for a READY invoice owned by the requester', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: 'invoice-1' });
      prisma.generatedDocument.findFirst.mockResolvedValue({
        xml: '<Invoice/>',
      });

      const document = await service.getGeneratedDocument(
        'invoice-1',
        'owner-1',
      );

      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          ownerId: 'owner-1',
          status: InvoiceStatus.READY,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        select: { id: true },
      });
      expect(prisma.generatedDocument.findFirst).toHaveBeenCalledWith({
        where: { invoiceId: 'invoice-1' },
        orderBy: { createdAt: 'desc' },
        select: { xml: true },
      });
      expect(document).toEqual({
        filename: 'xrechnung-invoice-1.xml',
        xml: '<Invoice/>',
      });
    });

    it('returns null when the invoice is not READY', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);

      const document = await service.getGeneratedDocument(
        'invoice-1',
        'owner-1',
      );

      expect(document).toBeNull();
      expect(prisma.generatedDocument.findFirst).not.toHaveBeenCalled();
    });

    it('returns null instead of leaking that a differently-owned invoice exists', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);

      const document = await service.getGeneratedDocument(
        'invoice-1',
        'owner-2',
      );

      expect(document).toBeNull();
    });
  });

  describe('getSourceDocument', () => {
    it('returns the original PDF for a live invoice owned by the requester', async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        originalFilename: 'source.pdf',
        storageKey: 'storage-key-1',
      });
      storage.read.mockResolvedValue(PDF_BUFFER);

      await expect(
        service.getSourceDocument('invoice-1', 'owner-1'),
      ).resolves.toEqual({ filename: 'source.pdf', pdf: PDF_BUFFER });

      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          ownerId: 'owner-1',
          expiresAt: { gt: expect.any(Date) as Date },
        },
        select: { originalFilename: true, storageKey: true },
      });
      expect(storage.read).toHaveBeenCalledWith('storage-key-1');
    });

    it('does not read storage when the invoice is expired or belongs to another owner', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);

      await expect(
        service.getSourceDocument('invoice-1', 'owner-2'),
      ).resolves.toBeNull();

      expect(storage.read).not.toHaveBeenCalled();
    });

    it('keeps a storage read failure retryable and reports service unavailability', async () => {
      const storageError = new Error('storage unavailable');
      prisma.invoice.findFirst.mockResolvedValue({
        originalFilename: 'source.pdf',
        storageKey: 'storage-key-1',
      });
      storage.read.mockRejectedValue(storageError);

      await expect(
        service.getSourceDocument('invoice-1', 'owner-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(logger.error).toHaveBeenCalledWith(
        { err: storageError, invoiceId: 'invoice-1' },
        'Failed to read uploaded PDF',
      );
    });

    it('reports a deleted source file as not found instead of a retryable outage', async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        originalFilename: 'source.pdf',
        storageKey: 'storage-key-1',
      });
      const missingFile = Object.assign(new Error('ENOENT'), {
        code: 'ENOENT',
      });
      storage.read.mockRejectedValue(missingFile);

      await expect(
        service.getSourceDocument('invoice-1', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
