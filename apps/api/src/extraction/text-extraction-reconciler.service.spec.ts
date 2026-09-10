import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { TextExtractionQueue } from './text-extraction-queue.service';
import { TextExtractionReconciler } from './text-extraction-reconciler.service';

const STAGE_STATUSES = [InvoiceStatus.UPLOADED, InvoiceStatus.EXTRACTING_TEXT];

describe('TextExtractionReconciler', () => {
  let reconciler: TextExtractionReconciler;
  let logger: { info: jest.Mock; debug: jest.Mock; setContext: jest.Mock };
  let prisma: { invoice: { findMany: jest.Mock } };
  let storage: jest.Mocked<StorageService>;
  let textExtractionQueue: {
    inFlightStatuses: InvoiceStatus[];
    requeueStranded: jest.Mock;
    reconcileFailedJobs: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { invoice: { findMany: jest.fn() } };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
    };
    textExtractionQueue = {
      inFlightStatuses: STAGE_STATUSES,
      requeueStranded: jest.fn().mockResolvedValue(true),
      reconcileFailedJobs: jest.fn().mockResolvedValue(0),
    };

    logger = { info: jest.fn(), debug: jest.fn(), setContext: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TextExtractionReconciler,
        { provide: PinoLogger, useValue: logger },
        { provide: PrismaService, useValue: prisma },
        { provide: TextExtractionQueue, useValue: textExtractionQueue },
        { provide: STORAGE_SERVICE, useValue: storage },
      ],
    }).compile();

    reconciler = module.get(TextExtractionReconciler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-enqueues stranded invoices in UPLOADED and EXTRACTING_TEXT whose file still exists', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1', status: InvoiceStatus.UPLOADED },
      {
        id: 'invoice-2',
        storageKey: 'key-2',
        status: InvoiceStatus.EXTRACTING_TEXT,
      },
    ]);
    storage.exists.mockResolvedValue(true);

    await reconciler.reconcile();

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { status: { in: STAGE_STATUSES } },
            { expiresAt: { gt: expect.any(Date) as Date } },
          ],
        },
      }),
    );
    expect(textExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'key-1',
    });
    expect(textExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-2',
      storageKey: 'key-2',
    });
  });

  it('does not enqueue a pre-save UPLOADED invoice whose stored file is missing', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1', status: InvoiceStatus.UPLOADED },
    ]);
    storage.exists.mockResolvedValue(false);

    await reconciler.reconcile();

    expect(textExtractionQueue.requeueStranded).not.toHaveBeenCalled();
  });

  it('enqueues a claimed EXTRACTING_TEXT invoice even when its stored file is missing, so the worker can dead-letter it', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: 'invoice-1',
        storageKey: 'key-1',
        status: InvoiceStatus.EXTRACTING_TEXT,
      },
    ]);
    storage.exists.mockResolvedValue(false);

    await reconciler.reconcile();

    expect(storage.exists).not.toHaveBeenCalled();
    expect(textExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'key-1',
    });
  });

  it('does nothing when no invoice is stranded', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(textExtractionQueue.requeueStranded).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
  });

  it('reconciles retained failed jobs before scanning active invoices', async () => {
    textExtractionQueue.reconcileFailedJobs.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(textExtractionQueue.reconcileFailedJobs).toHaveBeenCalledTimes(1);
  });

  it('pages through more than one batch of stranded invoices', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, index) => ({
      id: `invoice-${index}`,
      storageKey: `key-${index}`,
    }));
    prisma.invoice.findMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([{ id: 'invoice-100', storageKey: 'key-100' }]);
    storage.exists.mockResolvedValue(true);

    await reconciler.reconcile();

    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.invoice.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { id: { gt: 'invoice-99' } },
          ]) as unknown[],
        }) as object,
      }),
    );
    expect(textExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-100',
      storageKey: 'key-100',
    });
  });

  it('logs a summary only when it actually requeues something', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);
    storage.exists.mockResolvedValue(true);

    await reconciler.reconcile();

    expect(logger.info).toHaveBeenCalledWith(
      { stage: 'text-extraction', requeued: 1 },
      'Reconciled stranded jobs on startup',
    );
  });

  it('does not report an invoice recovered when its jobId was already occupied by a stale job', async () => {
    textExtractionQueue.requeueStranded.mockResolvedValue(false);
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);
    storage.exists.mockResolvedValue(true);

    await reconciler.reconcile();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Reconciled stranded jobs on startup',
    );
  });
});
