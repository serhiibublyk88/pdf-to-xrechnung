import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DataExtractionQueue } from './../src/data-extraction/data-extraction-queue.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { listenOnLoopback } from './support/listen-on-loopback';

async function waitForAttemptsMade(
  queue: Queue,
  jobId: string,
  minAttempts: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await queue.getJob(jobId);
    if (job && job.attemptsMade >= minAttempts) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Job ${jobId} did not reach attemptsMade >= ${minAttempts} within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

import { withBlockedInsert } from './support/fault-injection';
import { waitForStatus } from './support/wait-for-status';

describe('ExtractionAttempt persistence recovery under a real PostgreSQL failure (e2e)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let dataExtractionQueue: DataExtractionQueue;
  let primaryQueue: Queue;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
    dataExtractionQueue = app.get(DataExtractionQueue);
    primaryQueue = app.get<Queue>(getQueueToken(PipelineStage.DATA_EXTRACTION));
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await app.close();
  });

  it('retries the persistence failure through BullMQ instead of terminally failing the invoice, then reaches READY without an app restart', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const storageKey = randomUUID();
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey,
        originalFilename: 'recovery.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'Rechnungsnummer RE-2026-099 Gesamtbetrag 119,00 EUR',
        textCharCount: 50,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const jobId = lifecycleJobIdFor(
      PipelineStage.DATA_EXTRACTION,
      invoice.id,
      storageKey,
    );

    await withBlockedInsert(prisma, 'ExtractionAttempt', async () => {
      await dataExtractionQueue.enqueue({ invoiceId: invoice.id, storageKey });

      await waitForAttemptsMade(primaryQueue, jobId, 1);
      const midFlight = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(midFlight.status).toBe(InvoiceStatus.EXTRACTING_DATA);
      expect(midFlight.failureCode).toBeNull();
      expect(
        await prisma.extractionAttempt.count({
          where: { invoiceId: invoice.id },
        }),
      ).toBe(0);
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.READY,
      15_000,
    );
    expect(finished.status).toBe(InvoiceStatus.READY);

    const attempts = await prisma.extractionAttempt.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.parsedData).not.toBeNull();
  });
});
