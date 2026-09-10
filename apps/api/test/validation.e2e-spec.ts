import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import type { App } from 'supertest/types';
import { buildValidRawExtractedInvoiceData } from '../src/data-extraction/raw-extracted-invoice.fixture';
import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const validParsedData = buildValidRawExtractedInvoiceData;

describe('Deterministic validation (e2e)', () => {
  let seedModule: TestingModule;
  let prisma: PrismaService;
  let app: INestApplication<App> | null;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    seedModule = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    prisma = seedModule.get(PrismaService);
    await prisma.$connect();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    ownerIds.length = 0;
  });

  afterAll(async () => {
    await seedModule.close();
  });

  async function seedInvoice(
    status: InvoiceStatus,
    parsedData: RawExtractedInvoiceData,
  ): Promise<Invoice> {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'invoice.pdf',
        fileSizeBytes: 100,
        status,
        sourceType: SourceType.NATIVE,
        extractedText: 'synthetic invoice text',
        textCharCount: 22,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.extractionAttempt.create({
      data: {
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        attemptNumber: 1,
        provider: 'mock',
        model: 'mock-v1',
        promptVersion: 'v1',
        rawResponse: '{}',
        parsedData,
        durationMs: 1,
      },
    });
    return invoice;
  }

  async function startApplication(): Promise<void> {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  }

  it('routes a corrupted total to NEEDS_REVIEW and persists its failed rule', async () => {
    const parsedData = validParsedData();
    parsedData.grossTotal = '120.00';
    const invoice = await seedInvoice(InvoiceStatus.DATA_READY, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.NEEDS_REVIEW, 5_000);

    const failedGrossCheck = await prisma.validationResult.findFirstOrThrow({
      where: {
        invoiceId: invoice.id,
        rule: 'arithmetic.gross',
        passed: false,
      },
    });
    expect(failedGrossCheck.expected).toBe('119.00');
    expect(failedGrossCheck.actual).toBe('120.00');
  });

  it('recovers a stranded VALIDATING invoice and replaces stale validation results', async () => {
    const invoice = await seedInvoice(
      InvoiceStatus.VALIDATING,
      validParsedData(),
    );
    await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'stale.result',
        severity: 'ERROR',
        passed: false,
        message: 'stale result',
      },
    });

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 5_000);

    expect(
      await prisma.validationResult.findFirst({
        where: { invoiceId: invoice.id, rule: 'stale.result' },
      }),
    ).toBeNull();
    expect(
      await prisma.validationResult.count({
        where: {
          invoiceId: invoice.id,
          passed: true,
        },
      }),
    ).toBeGreaterThan(0);
  });
});
