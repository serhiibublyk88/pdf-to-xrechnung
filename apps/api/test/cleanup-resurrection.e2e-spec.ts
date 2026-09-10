import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Invoice, InvoiceStatus, Prisma, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../src/config/env.schema';
import { CleanupService } from '../src/cleanup/cleanup.service';
import { InvoicesService } from '../src/invoices/invoices.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { StorageService } from '../src/storage/storage.interface';
import type { TextExtractionQueue } from '../src/extraction/text-extraction-queue.service';
import { buildMinimalPdf } from '../evals/pdf-builders';

const RETENTION_HOURS = 2;
const logger = new PinoLogger({ pinoHttp: { enabled: false } });

function fakeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    DATABASE_URL: process.env.DATABASE_URL,
    RETENTION_HOURS,
    ...overrides,
  };
  return new ConfigService<Env, true>(values);
}

function createSharedStorage(): {
  files: Map<string, Buffer>;
  plain: StorageService;
  gated: StorageService & { armDeleteGate: () => Promise<() => void> };
} {
  const files = new Map<string, Buffer>();

  const plain: StorageService = {
    save: (storageKey, data) => {
      files.set(storageKey, data);
      return Promise.resolve();
    },
    read: (storageKey) => {
      const storedFile = files.get(storageKey);
      return storedFile
        ? Promise.resolve(storedFile)
        : Promise.reject(new Error(`no file for storage key ${storageKey}`));
    },
    delete: (storageKey) => {
      files.delete(storageKey);
      return Promise.resolve();
    },
    exists: (storageKey) => Promise.resolve(files.has(storageKey)),
  };

  let onDeleteStarted: (() => void) | null = null;
  let gate: Promise<void> | null = null;

  const gated: StorageService & { armDeleteGate: () => Promise<() => void> } = {
    save: (storageKey, data) => plain.save(storageKey, data),
    read: (storageKey) => plain.read(storageKey),
    exists: (storageKey) => plain.exists(storageKey),
    delete: async (storageKey) => {
      onDeleteStarted?.();
      if (gate) {
        await gate;
      }
      files.delete(storageKey);
    },
    armDeleteGate: () =>
      new Promise<() => void>((resolveArmed) => {
        let release: () => void = () => undefined;
        gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        onDeleteStarted = () => resolveArmed(release);
      }),
  };

  return { files, plain, gated };
}

describe('Cleanup vs. resurrection race (e2e)', () => {
  let prisma: PrismaService;
  const createdOwnerIds: string[] = [];
  const pdf = buildMinimalPdf(
    'Rechnungsnummer RE-2026-002 Gesamtbetrag 50,00 EUR',
  );
  const file = {
    buffer: pdf,
    originalname: 'invoice.pdf',
  };
  const stubQueue = {
    enqueue: jest.fn(),
  } as unknown as TextExtractionQueue;
  const stubFailedQueue: Pick<Queue, 'clean'> = {
    clean: () => Promise.resolve([]),
  };
  const stubDlq: Pick<Queue, 'getJob' | 'clean'> = {
    getJob: () => Promise.resolve(undefined),
    clean: () => Promise.resolve([]),
  };
  const fileHash = createHash('sha256').update(pdf).digest('hex');

  beforeAll(async () => {
    prisma = new PrismaService(fakeConfig());
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.invoice.deleteMany({
      where: { ownerId: { in: createdOwnerIds.splice(0) } },
    });
  });

  async function seedExpiredInvoice(
    ownerId: string,
    overrides: Partial<Invoice> = {},
  ): Promise<Invoice> {
    createdOwnerIds.push(ownerId);
    const { reviewedData, failureParams, ...invoiceOverrides } = overrides;
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash,
        storageKey: randomUUID(),
        originalFilename: 'old.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'old text',
        textCharCount: 8,
        reviewedData: reviewedData === null ? Prisma.DbNull : reviewedData,
        failureParams: failureParams === null ? Prisma.DbNull : failureParams,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
        ...invoiceOverrides,
      },
    });
  }

  it('resets a resurrected invoice and clears its child artifacts under the reused id', async () => {
    const ownerId = randomUUID();
    const { plain } = createSharedStorage();
    const expired = await seedExpiredInvoice(ownerId);
    await plain.save(expired.storageKey, Buffer.from('old file'));
    await prisma.extractionAttempt.create({
      data: {
        invoiceId: expired.id,
        storageKey: expired.storageKey,
        attemptNumber: 1,
        provider: 'mock',
        model: 'mock-1',
        promptVersion: 'v1',
        rawResponse: '{}',
        durationMs: 10,
      },
    });
    await prisma.validationResult.create({
      data: {
        invoiceId: expired.id,
        rule: 'arithmetic.net_plus_tax',
        severity: 'ERROR',
        passed: false,
        message: 'mismatch',
      },
    });
    await prisma.generatedDocument.create({
      data: {
        invoiceId: expired.id,
        format: 'XRECHNUNG_UBL',
        xml: '<Invoice/>',
        isValid: true,
      },
    });

    const invoicesService = new InvoicesService(
      prisma,
      fakeConfig(),
      plain,
      stubQueue,
      logger,
    );

    const ingestResult = await invoicesService.ingest({ ownerId, file });

    expect(ingestResult.id).toBe(expired.id);
    expect(ingestResult.deduplicated).toBe(false);
    expect(ingestResult.status).toBe(InvoiceStatus.UPLOADED);

    const refreshed = await prisma.invoice.findUniqueOrThrow({
      where: { id: expired.id },
    });
    expect(refreshed.storageKey).not.toBe(expired.storageKey);
    expect(refreshed.extractedText).toBeNull();
    expect(refreshed.createdAt.getTime()).toBeGreaterThan(
      expired.createdAt.getTime(),
    );
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [attempts, validations, documents] = await Promise.all([
      prisma.extractionAttempt.count({ where: { invoiceId: expired.id } }),
      prisma.validationResult.count({ where: { invoiceId: expired.id } }),
      prisma.generatedDocument.count({ where: { invoiceId: expired.id } }),
    ]);
    expect(attempts).toBe(0);
    expect(validations).toBe(0);
    expect(documents).toBe(0);

    await expect(plain.read(expired.storageKey)).rejects.toThrow();
  });

  it('does not let a concurrent cleanup run delete an invoice a resurrection just reset', async () => {
    const ownerId = randomUUID();
    const { plain, gated } = createSharedStorage();
    const expired = await seedExpiredInvoice(ownerId);
    await plain.save(expired.storageKey, Buffer.from('old file'));

    const cleanupService = new CleanupService(
      prisma,
      fakeConfig(),
      new SchedulerRegistry(),
      gated,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      logger,
    );
    const invoicesService = new InvoicesService(
      prisma,
      fakeConfig(),
      plain,
      stubQueue,
      logger,
    );

    const armed = gated.armDeleteGate();
    const cleanupRun = cleanupService.run();
    const release = await armed;

    const ingestResult = await invoicesService.ingest({ ownerId, file });
    expect(ingestResult.deduplicated).toBe(false);
    expect(ingestResult.id).toBe(expired.id);

    release();
    await cleanupRun;

    const survivor = await prisma.invoice.findUniqueOrThrow({
      where: { id: expired.id },
    });
    expect(survivor.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(survivor.status).toBe(InvoiceStatus.UPLOADED);
  });

  it('removes a genuinely expired invoice with its child rows, then a later upload starts a fresh lifecycle', async () => {
    const ownerId = randomUUID();
    const { plain } = createSharedStorage();
    const expired = await seedExpiredInvoice(ownerId);
    await plain.save(expired.storageKey, Buffer.from('old file'));
    await prisma.extractionAttempt.create({
      data: {
        invoiceId: expired.id,
        storageKey: expired.storageKey,
        attemptNumber: 1,
        provider: 'mock',
        model: 'mock-1',
        promptVersion: 'v1',
        rawResponse: '{}',
        durationMs: 10,
      },
    });

    const cleanupService = new CleanupService(
      prisma,
      fakeConfig(),
      new SchedulerRegistry(),
      plain,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      stubFailedQueue,
      stubDlq,
      logger,
    );
    await cleanupService.run();

    expect(
      await prisma.invoice.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(
      await prisma.extractionAttempt.count({
        where: { invoiceId: expired.id },
      }),
    ).toBe(0);

    const invoicesService = new InvoicesService(
      prisma,
      fakeConfig(),
      plain,
      stubQueue,
      logger,
    );
    const ingestResult = await invoicesService.ingest({ ownerId, file });

    expect(ingestResult.id).not.toBe(expired.id);
    expect(ingestResult.deduplicated).toBe(false);
    createdOwnerIds.push(ownerId);
  });

  it('leaves an expired invoice retryable instead of half-reset when deleting its old file fails', async () => {
    const ownerId = randomUUID();
    const { plain } = createSharedStorage();
    const expired = await seedExpiredInvoice(ownerId);
    await plain.save(expired.storageKey, Buffer.from('old file'));
    const failingStorage: StorageService = {
      ...plain,
      delete: () => Promise.reject(new Error('disk unavailable')),
    };

    const invoicesService = new InvoicesService(
      prisma,
      fakeConfig(),
      failingStorage,
      stubQueue,
      logger,
    );

    await expect(invoicesService.ingest({ ownerId, file })).rejects.toThrow(
      'disk unavailable',
    );

    const untouched = await prisma.invoice.findUniqueOrThrow({
      where: { id: expired.id },
    });
    expect(untouched.storageKey).toBe(expired.storageKey);
    expect(untouched.status).toBe(InvoiceStatus.TEXT_READY);
    expect(untouched.expiresAt.getTime()).toBe(expired.expiresAt.getTime());
  });
});
