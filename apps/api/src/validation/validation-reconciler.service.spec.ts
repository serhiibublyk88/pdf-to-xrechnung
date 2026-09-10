import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationReconciler } from './validation-reconciler.service';
import { ValidationQueue } from './validation-queue.service';

const STAGE_STATUSES = [InvoiceStatus.DATA_READY, InvoiceStatus.VALIDATING];

describe('ValidationReconciler', () => {
  let reconciler: ValidationReconciler;
  let logger: { info: jest.Mock; debug: jest.Mock; setContext: jest.Mock };
  let prisma: { invoice: { findMany: jest.Mock } };
  let validationQueue: {
    inFlightStatuses: InvoiceStatus[];
    requeueStranded: jest.Mock;
    reconcileFailedJobs: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { invoice: { findMany: jest.fn() } };
    validationQueue = {
      inFlightStatuses: STAGE_STATUSES,
      requeueStranded: jest.fn().mockResolvedValue(true),
      reconcileFailedJobs: jest.fn().mockResolvedValue(0),
    };

    logger = { info: jest.fn(), debug: jest.fn(), setContext: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationReconciler,
        { provide: PinoLogger, useValue: logger },
        { provide: PrismaService, useValue: prisma },
        { provide: ValidationQueue, useValue: validationQueue },
      ],
    }).compile();

    reconciler = module.get(ValidationReconciler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-enqueues stranded DATA_READY and VALIDATING invoices', async () => {
    const now = new Date('2026-08-10T12:00:00.000Z');
    jest.useFakeTimers({ now });
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
      { id: 'invoice-2', storageKey: 'key-2' },
    ]);

    try {
      await reconciler.reconcile();

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { status: { in: STAGE_STATUSES } },
              { expiresAt: { gt: now } },
            ],
          },
        }),
      );
      expect(validationQueue.requeueStranded).toHaveBeenCalledWith({
        invoiceId: 'invoice-1',
        storageKey: 'key-1',
      });
      expect(validationQueue.requeueStranded).toHaveBeenCalledWith({
        invoiceId: 'invoice-2',
        storageKey: 'key-2',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles exhausted validation jobs before scanning active invoices', async () => {
    validationQueue.reconcileFailedJobs.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValueOnce([]);

    await reconciler.reconcile();

    expect(validationQueue.reconcileFailedJobs).toHaveBeenCalledTimes(1);
  });

  it('logs a recovery summary when it re-enqueues invoices', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);

    await reconciler.reconcile();

    expect(logger.info).toHaveBeenCalledWith(
      { stage: 'validation', requeued: 1 },
      'Reconciled stranded jobs on startup',
    );
  });

  it('does not report an invoice recovered when its jobId was already occupied by a stale job', async () => {
    validationQueue.requeueStranded.mockResolvedValue(false);
    prisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);

    await reconciler.reconcile();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Reconciled stranded jobs on startup',
    );
  });
});
