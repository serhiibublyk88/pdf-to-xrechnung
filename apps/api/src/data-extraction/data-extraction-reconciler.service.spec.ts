import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DataExtractionQueue } from './data-extraction-queue.service';
import { DataExtractionReconciler } from './data-extraction-reconciler.service';

const STAGE_STATUSES = [
  InvoiceStatus.TEXT_READY,
  InvoiceStatus.EXTRACTING_DATA,
];

describe('DataExtractionReconciler', () => {
  let reconciler: DataExtractionReconciler;
  let logger: { info: jest.Mock; debug: jest.Mock; setContext: jest.Mock };
  let prisma: { invoice: { findMany: jest.Mock } };
  let dataExtractionQueue: {
    inFlightStatuses: InvoiceStatus[];
    requeueStranded: jest.Mock;
    reconcileFailedJobs: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { invoice: { findMany: jest.fn() } };
    dataExtractionQueue = {
      inFlightStatuses: STAGE_STATUSES,
      requeueStranded: jest.fn().mockResolvedValue(true),
      reconcileFailedJobs: jest.fn().mockResolvedValue(0),
    };

    logger = { info: jest.fn(), debug: jest.fn(), setContext: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExtractionReconciler,
        { provide: PinoLogger, useValue: logger },
        { provide: PrismaService, useValue: prisma },
        { provide: DataExtractionQueue, useValue: dataExtractionQueue },
      ],
    }).compile();

    reconciler = module.get(DataExtractionReconciler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-enqueues stranded invoices in TEXT_READY and EXTRACTING_DATA', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
      { id: 'invoice-2', storageKey: 'key-2' },
    ]);

    await reconciler.reconcile();

    expect(dataExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'key-1',
    });
    expect(dataExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-2',
      storageKey: 'key-2',
    });
  });

  it('scans both stage statuses without a text predicate, and never selects invoice text', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { status: { in: STAGE_STATUSES } },
            { expiresAt: { gt: expect.any(Date) as Date } },
          ],
        },
        select: { id: true, storageKey: true, status: true },
      }),
    );
    expect(dataExtractionQueue.requeueStranded).not.toHaveBeenCalled();
  });

  it('re-enqueues a stranded row with no persisted text: the processor classifies it after claiming', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: 'invoice-1',
        storageKey: 'key-1',
        status: InvoiceStatus.TEXT_READY,
      },
    ]);

    await reconciler.reconcile();

    expect(dataExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      storageKey: 'key-1',
    });
  });

  it('does nothing when no invoice is stranded', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(dataExtractionQueue.requeueStranded).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
  });

  it('reconciles retained failed jobs before scanning active invoices', async () => {
    dataExtractionQueue.reconcileFailedJobs.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(dataExtractionQueue.reconcileFailedJobs).toHaveBeenCalledTimes(1);
  });

  it('pages through more than one batch of stranded invoices', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, index) => ({
      id: `invoice-${index}`,
      storageKey: `key-${index}`,
      extractedText: 'text',
    }));
    prisma.invoice.findMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([
        { id: 'invoice-100', storageKey: 'key-100', extractedText: 'text' },
      ]);

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
    expect(dataExtractionQueue.requeueStranded).toHaveBeenCalledWith({
      invoiceId: 'invoice-100',
      storageKey: 'key-100',
    });
  });

  it('logs a summary only when it actually requeues something', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1', extractedText: 'text-1' },
    ]);

    await reconciler.reconcile();

    expect(logger.info).toHaveBeenCalledWith(
      { stage: 'data-extraction', requeued: 1 },
      'Reconciled stranded jobs on startup',
    );
  });

  it('does not report an invoice recovered when its jobId was already occupied by a stale job', async () => {
    dataExtractionQueue.requeueStranded.mockResolvedValue(false);
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1', extractedText: 'text-1' },
    ]);

    await reconciler.reconcile();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Reconciled stranded jobs on startup',
    );
  });
});
