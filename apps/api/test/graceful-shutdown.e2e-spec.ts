import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvoiceStatus, SourceType } from '@prisma/client';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DataExtractionProcessor } from './../src/data-extraction/data-extraction.processor';
import { DataExtractionQueue } from './../src/data-extraction/data-extraction-queue.service';
import {
  LLM_PROVIDER,
  type LlmProvider,
} from './../src/data-extraction/llm-provider.interface';
import { MockProvider } from './../src/data-extraction/mock-provider';
import { PrismaService } from './../src/prisma/prisma.service';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('Graceful shutdown (e2e)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets an in-flight stage job finish before the database client disconnects', async () => {
    const mockProvider = new MockProvider();
    let markExtractionStarted: () => void = () => {};
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    let releaseExtraction: () => void = () => {};
    const extractionHeld = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const heldProvider: LlmProvider = {
      name: mockProvider.name,
      model: mockProvider.model,
      extract: async () => {
        markExtractionStarted();
        await extractionHeld;
        return mockProvider.extract();
      },
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(heldProvider)
      .compile();
    const app: INestApplication<App> = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    const prisma = app.get(PrismaService);
    const ownerId = randomUUID();
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'shutdown.pdf',
        fileSizeBytes: 100,
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'Rechnung RE-2026-001 Gesamtbetrag 119,00 EUR',
        textCharCount: 46,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await app.get(DataExtractionQueue).enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });
    await extractionStarted;

    const shutdownOrder: string[] = [];
    const worker = app.get(DataExtractionProcessor).worker;
    worker.on('completed', () => shutdownOrder.push('job completed'));
    const closeWorker = worker.close.bind(worker);
    jest.spyOn(worker, 'close').mockImplementation((force) => {
      releaseExtraction();
      return closeWorker(force);
    });
    const disconnect = prisma.$disconnect.bind(prisma);
    jest.spyOn(prisma, '$disconnect').mockImplementation(() => {
      shutdownOrder.push('database disconnected');
      releaseExtraction();
      return disconnect();
    });

    await app.close();

    expect(shutdownOrder).toEqual(['job completed', 'database disconnected']);

    jest.restoreAllMocks();
    await prisma.$connect();
    await prisma.invoice.deleteMany({ where: { ownerId } });
    await prisma.$disconnect();
  });
});
