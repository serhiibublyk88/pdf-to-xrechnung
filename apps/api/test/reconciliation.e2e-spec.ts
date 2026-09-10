import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { App } from 'supertest/types';
import { ConfigModule } from './../src/config/config.module';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageModule } from './../src/storage/storage.module';
import { STORAGE_SERVICE } from './../src/storage/storage.interface';
import type { StorageService } from './../src/storage/storage.interface';
import { AppModule } from './../src/app.module';
import { reconcileStage } from './../src/queue/stranded-invoices';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { buildMinimalPdf } from '../evals/pdf-builders';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('Startup reconciliation of stranded text-extraction jobs (e2e)', () => {
  let seedModule: TestingModule;
  let prisma: PrismaService;
  let storage: StorageService;
  const pdf = buildMinimalPdf(
    'Rechnungsnummer RE-2026-003 Gesamtbetrag 75,00 EUR',
  );
  const createdOwnerIds: string[] = [];
  const createdStorageKeys: string[] = [];

  beforeAll(async () => {
    seedModule = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, StorageModule],
    }).compile();
    prisma = seedModule.get(PrismaService);
    await prisma.$connect();
    storage = seedModule.get(STORAGE_SERVICE);
  });

  afterAll(async () => {
    await Promise.all(
      createdStorageKeys.map((storageKey) => storage.delete(storageKey)),
    );
    await prisma.invoice.deleteMany({
      where: { ownerId: { in: createdOwnerIds } },
    });
    await seedModule.close();
  });

  async function seedStranded(status: InvoiceStatus): Promise<Invoice> {
    const ownerId = randomUUID();
    createdOwnerIds.push(ownerId);
    const storageKey = randomUUID();
    createdStorageKeys.push(storageKey);
    await storage.save(storageKey, pdf);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey,
        originalFilename: 'stranded.pdf',
        fileSizeBytes: pdf.length,
        status,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  async function seedStrandedWithMissingFile(
    status: InvoiceStatus = InvoiceStatus.UPLOADED,
  ): Promise<Invoice> {
    const ownerId = randomUUID();
    createdOwnerIds.push(ownerId);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'stranded.pdf',
        fileSizeBytes: pdf.length,
        status,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it('re-queues an UPLOADED invoice with no job behind it and lets it complete', async () => {
    const stranded = await seedStranded(InvoiceStatus.UPLOADED);

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const finished = await waitForStatus(
        prisma,
        stranded.id,
        (status) =>
          status === InvoiceStatus.READY ||
          status === InvoiceStatus.NEEDS_REVIEW ||
          status === InvoiceStatus.FAILED,
        5_000,
      );
      expect(finished.status).toBe(InvoiceStatus.READY);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('re-queues an EXTRACTING_TEXT invoice with no job behind it and lets it complete', async () => {
    const stranded = await seedStranded(InvoiceStatus.EXTRACTING_TEXT);

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const finished = await waitForStatus(
        prisma,
        stranded.id,
        (status) =>
          status === InvoiceStatus.READY ||
          status === InvoiceStatus.NEEDS_REVIEW ||
          status === InvoiceStatus.FAILED,
        5_000,
      );
      expect(finished.status).toBe(InvoiceStatus.READY);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('does not enqueue a row whose stored file is missing', async () => {
    const stranded = await seedStrandedWithMissingFile();

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      // app.init() awaits onApplicationBootstrap, so reconciliation has already run.
      const untouched = await prisma.invoice.findUniqueOrThrow({
        where: { id: stranded.id },
      });
      expect(untouched.status).toBe(InvoiceStatus.UPLOADED);
    } finally {
      await app.close();
    }
  });

  it('dead-letters a claimed EXTRACTING_TEXT invoice whose stored file is missing, instead of leaving it active', async () => {
    const stranded = await seedStrandedWithMissingFile(
      InvoiceStatus.EXTRACTING_TEXT,
    );

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const finished = await waitForStatus(
        prisma,
        stranded.id,
        (status) => status === InvoiceStatus.FAILED,
        20_000,
      );
      expect(finished.failureCode).toBe('text_extraction_retries_exhausted');

      const dlq = appModule.get<Queue>(
        getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
      );
      const jobId = lifecycleJobIdFor(
        PipelineStage.TEXT_EXTRACTION,
        stranded.id,
        stranded.storageKey,
      );
      expect(await dlq.getJob(jobId)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 25_000);

  it('does not re-queue an expired invoice', async () => {
    const stranded = await seedStranded(InvoiceStatus.UPLOADED);
    await prisma.invoice.update({
      where: { id: stranded.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const untouched = await prisma.invoice.findUniqueOrThrow({
        where: { id: stranded.id },
      });
      expect(untouched.status).toBe(InvoiceStatus.UPLOADED);
    } finally {
      await app.close();
    }
  });
});

describe('Startup reconciliation of stranded data-extraction jobs (e2e)', () => {
  let seedModule: TestingModule;
  let prisma: PrismaService;
  const createdOwnerIds: string[] = [];

  beforeAll(async () => {
    seedModule = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    prisma = seedModule.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({
      where: { ownerId: { in: createdOwnerIds } },
    });
    await seedModule.close();
  });

  async function seedStranded(status: InvoiceStatus): Promise<Invoice> {
    const ownerId = randomUUID();
    createdOwnerIds.push(ownerId);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'stranded.pdf',
        fileSizeBytes: 100,
        status,
        sourceType: SourceType.NATIVE,
        extractedText: 'synthetic invoice text',
        textCharCount: 22,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it('re-queues a TEXT_READY invoice with no job behind it and lets it complete', async () => {
    const stranded = await seedStranded(InvoiceStatus.TEXT_READY);

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const finished = await waitForStatus(
        prisma,
        stranded.id,
        (status) =>
          status === InvoiceStatus.READY ||
          status === InvoiceStatus.NEEDS_REVIEW ||
          status === InvoiceStatus.FAILED,
        15_000,
      );
      expect(finished.status).toBe(InvoiceStatus.READY);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('re-queues an EXTRACTING_DATA invoice with no job behind it and lets it complete', async () => {
    const stranded = await seedStranded(InvoiceStatus.EXTRACTING_DATA);

    const appModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = appModule.createNestApplication();
    await listenOnLoopback(app);

    try {
      const finished = await waitForStatus(
        prisma,
        stranded.id,
        (status) =>
          status === InvoiceStatus.READY ||
          status === InvoiceStatus.NEEDS_REVIEW ||
          status === InvoiceStatus.FAILED,
        15_000,
      );
      expect(finished.status).toBe(InvoiceStatus.READY);
    } finally {
      await app.close();
    }
  }, 20_000);

  it.each([
    [InvoiceStatus.TEXT_READY, null],
    [InvoiceStatus.TEXT_READY, ''],
    [InvoiceStatus.EXTRACTING_DATA, null],
    [InvoiceStatus.EXTRACTING_DATA, ''],
  ])(
    'fails a stranded %s invoice with %j extractedText deterministically, without an extraction attempt',
    async (status, extractedText) => {
      const ownerId = randomUUID();
      createdOwnerIds.push(ownerId);
      const stranded = await prisma.invoice.create({
        data: {
          ownerId,
          fileHash: randomUUID(),
          storageKey: randomUUID(),
          originalFilename: 'stranded.pdf',
          fileSizeBytes: 100,
          status,
          sourceType: SourceType.NATIVE,
          extractedText,
          textCharCount: extractedText?.length ?? 0,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const appModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app: INestApplication<App> = appModule.createNestApplication();
      await listenOnLoopback(app);

      try {
        const finished = await waitForStatus(
          prisma,
          stranded.id,
          (currentStatus) => currentStatus === InvoiceStatus.FAILED,
          15_000,
        );
        expect(finished.failureCode).toBe('llm_no_usable_data');
        expect(
          await prisma.extractionAttempt.count({
            where: { invoiceId: stranded.id },
          }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    20_000,
  );
});

describe('requeueStrandedInvoices keyset pagination under real PostgreSQL (e2e)', () => {
  let seedModule: TestingModule;
  let prisma: PrismaService;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    seedModule = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    prisma = seedModule.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await seedModule.close();
  });

  it('processes the 101st row after the page-1 anchor (the 100th row) is deleted mid-scan', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const seeded = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        prisma.invoice.create({
          data: {
            ownerId,
            fileHash: `keyset-page-${index}`,
            storageKey: randomUUID(),
            originalFilename: 'stranded.pdf',
            fileSizeBytes: 10,
            status: InvoiceStatus.UPLOADED,
            sourceType: SourceType.UNKNOWN,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        }),
      ),
    );
    const seededIds = seeded.map((invoice) => invoice.id).sort();

    const visitedIds: string[] = [];
    let deletedAnchor = false;
    await reconcileStage({
      prisma,
      queue: { reconcileFailedJobs: () => Promise.resolve(0) },
      stage: PipelineStage.TEXT_EXTRACTION,
      logger: new PinoLogger({ pinoHttp: { enabled: false } }),
      where: { ownerId },
      requeue: async (invoice) => {
        visitedIds.push(invoice.id);
        if (visitedIds.length === 100 && !deletedAnchor) {
          deletedAnchor = true;
          await prisma.invoice.delete({ where: { id: invoice.id } });
        }
        return true;
      },
    });

    expect(deletedAnchor).toBe(true);
    expect(visitedIds.sort()).toEqual(seededIds);
  });

  it('does not process expired or non-matching rows', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const matching = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: 'keyset-matching',
        storageKey: randomUUID(),
        originalFilename: 'stranded.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.UPLOADED,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: 'keyset-expired',
        storageKey: randomUUID(),
        originalFilename: 'stranded.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.UPLOADED,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: 'keyset-wrong-status',
        storageKey: randomUUID(),
        originalFilename: 'stranded.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.READY,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const visitedIds: string[] = [];
    await reconcileStage({
      prisma,
      queue: { reconcileFailedJobs: () => Promise.resolve(0) },
      stage: PipelineStage.TEXT_EXTRACTION,
      logger: new PinoLogger({ pinoHttp: { enabled: false } }),
      where: { ownerId, status: InvoiceStatus.UPLOADED },
      requeue: (invoice) => {
        visitedIds.push(invoice.id);
        return Promise.resolve(true);
      },
    });

    expect(visitedIds).toEqual([matching.id]);
  });
});
