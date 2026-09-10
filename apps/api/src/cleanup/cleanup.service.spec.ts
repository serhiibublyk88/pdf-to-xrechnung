import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from '../queue/pipeline-stage';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { CleanupService } from './cleanup.service';

const CLEANUP_INTERVAL_MINUTES = 10;
const RETENTION_HOURS = 2;
const CONFIG_VALUES: Record<string, number> = {
  CLEANUP_INTERVAL_MINUTES,
  RETENTION_HOURS,
};

describe('CleanupService', () => {
  let service: CleanupService;
  let prisma: {
    invoice: { findMany: jest.Mock; deleteMany: jest.Mock };
    pendingStorageDeletion: { findMany: jest.Mock; deleteMany: jest.Mock };
  };
  let storage: jest.Mocked<StorageService>;
  let queue: { clean: jest.Mock };
  let dlq: { getJob: jest.Mock; clean: jest.Mock };
  let dataExtractionQueue: { clean: jest.Mock };
  let dataExtractionDlq: { getJob: jest.Mock; clean: jest.Mock };
  let validationQueue: { clean: jest.Mock };
  let validationDlq: { getJob: jest.Mock; clean: jest.Mock };
  let generationQueue: { clean: jest.Mock };
  let generationDlq: { getJob: jest.Mock; clean: jest.Mock };
  let logger: { error: jest.Mock; info: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    logger = { error: jest.fn(), info: jest.fn(), setContext: jest.fn() };
    prisma = {
      invoice: {
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      pendingStorageDeletion: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
    };
    queue = { clean: jest.fn().mockResolvedValue([]) };
    dlq = {
      getJob: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn().mockResolvedValue([]),
    };
    dataExtractionQueue = { clean: jest.fn().mockResolvedValue([]) };
    dataExtractionDlq = {
      getJob: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn().mockResolvedValue([]),
    };
    validationQueue = { clean: jest.fn().mockResolvedValue([]) };
    validationDlq = {
      getJob: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn().mockResolvedValue([]),
    };
    generationQueue = { clean: jest.fn().mockResolvedValue([]) };
    generationDlq = {
      getJob: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanupService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => CONFIG_VALUES[key] },
        },
        {
          provide: SchedulerRegistry,
          useValue: { addInterval: jest.fn(), deleteInterval: jest.fn() },
        },
        { provide: STORAGE_SERVICE, useValue: storage },
        {
          provide: getQueueToken(PipelineStage.TEXT_EXTRACTION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
          useValue: dlq,
        },
        {
          provide: getQueueToken(PipelineStage.DATA_EXTRACTION),
          useValue: dataExtractionQueue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.DATA_EXTRACTION)),
          useValue: dataExtractionDlq,
        },
        {
          provide: getQueueToken(PipelineStage.VALIDATION),
          useValue: validationQueue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
          useValue: validationDlq,
        },
        {
          provide: getQueueToken(PipelineStage.GENERATION),
          useValue: generationQueue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.GENERATION)),
          useValue: generationDlq,
        },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    service = module.get(CleanupService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps cleaning up the remaining invoices when one of them fails', async () => {
    const diskError = new Error('disk error');
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'invoice-1', storageKey: 'key-1' },
      { id: 'invoice-2', storageKey: 'key-2' },
      { id: 'invoice-3', storageKey: 'key-3' },
    ]);
    storage.delete.mockImplementation((storageKey: string) =>
      storageKey === 'key-2' ? Promise.reject(diskError) : Promise.resolve(),
    );
    const deletedInvoiceIds: string[] = [];
    prisma.invoice.deleteMany.mockImplementation(
      (input: { where: { id: string } }) => {
        deletedInvoiceIds.push(input.where.id);
        return Promise.resolve({ count: 1 });
      },
    );

    await service.run();

    expect(storage.delete).toHaveBeenCalledTimes(3);
    expect(deletedInvoiceIds).toEqual(['invoice-1', 'invoice-3']);
    expect(logger.error).toHaveBeenCalledWith(
      { err: diskError, invoiceId: 'invoice-2' },
      'Failed to clean up invoice',
    );
  });

  it('does not clean up the same invoice twice when two runs overlap', async () => {
    prisma.invoice.findMany.mockImplementation(
      () =>
        new Promise((resolve) =>
          setImmediate(() =>
            resolve([{ id: 'invoice-1', storageKey: 'key-1' }]),
          ),
        ),
    );

    await Promise.all([service.run(), service.run()]);

    expect(prisma.invoice.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending file deletion retryable when storage is unavailable', async () => {
    const diskError = new Error('disk error');
    prisma.pendingStorageDeletion.findMany.mockResolvedValue([
      { storageKey: 'key-1' },
    ]);
    prisma.invoice.findMany.mockResolvedValue([]);
    storage.delete.mockRejectedValue(diskError);

    await service.run();

    expect(prisma.pendingStorageDeletion.deleteMany).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { err: diskError },
      'Failed to clean up pending stored file',
    );
  });

  it('clears a pending deletion marker after the stored file is gone', async () => {
    prisma.pendingStorageDeletion.findMany
      .mockResolvedValueOnce([{ storageKey: 'key-1' }])
      .mockResolvedValueOnce([]);
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.run();
    await service.run();

    expect(prisma.pendingStorageDeletion.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.pendingStorageDeletion.deleteMany).toHaveBeenCalledWith({
      where: { storageKey: 'key-1' },
    });
  });

  it('does not count a row as cleaned when a concurrent upload resurrected it first', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);
    prisma.invoice.deleteMany.mockResolvedValue({ count: 0 });
    await service.run();

    expect(prisma.invoice.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'invoice-1',
        storageKey: 'key-1',
        expiresAt: { lte: expect.any(Date) as Date },
      },
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('bounds how many expired invoices it loads in one run', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.run();

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it('removes the dead-letter entry for an invoice it actually deleted', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);
    const dlqJob = { remove: jest.fn() };
    dlq.getJob.mockResolvedValue(dlqJob);

    await service.run();

    expect(dlq.getJob).toHaveBeenCalledWith(
      lifecycleJobIdFor(PipelineStage.TEXT_EXTRACTION, 'invoice-1', 'key-1'),
    );
    expect(dataExtractionDlq.getJob).toHaveBeenCalledWith(
      lifecycleJobIdFor(PipelineStage.DATA_EXTRACTION, 'invoice-1', 'key-1'),
    );
    expect(validationDlq.getJob).toHaveBeenCalledWith(
      lifecycleJobIdFor(PipelineStage.VALIDATION, 'invoice-1', 'key-1'),
    );
    expect(generationDlq.getJob).toHaveBeenCalledWith(
      lifecycleJobIdFor(PipelineStage.GENERATION, 'invoice-1', 'key-1'),
    );
    expect(dlqJob.remove).toHaveBeenCalled();
  });

  it('does not fail the run when an invoice has no dead-letter entry to remove', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'invoice-1', storageKey: 'key-1' },
    ]);
    dlq.getJob.mockResolvedValue(undefined);

    await expect(service.run()).resolves.toBeUndefined();
  });

  it('sweeps stale dead-letter entries older than the retention window as a fallback', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.run();

    expect(dlq.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'wait',
    );
  });

  it('sweeps retained failed jobs after the retention window', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.run();

    expect(queue.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'failed',
    );
  });

  it('sweeps the data-extraction and validation primary and dead-letter queues too', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.run();

    expect(dataExtractionQueue.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'failed',
    );
    expect(dataExtractionDlq.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'wait',
    );
    expect(validationQueue.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'failed',
    );
    expect(validationDlq.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'wait',
    );
    expect(generationQueue.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'failed',
    );
    expect(generationDlq.clean).toHaveBeenCalledWith(
      RETENTION_HOURS * 60 * 60 * 1000,
      1000,
      'wait',
    );
  });
});
