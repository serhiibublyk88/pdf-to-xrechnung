import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { PrismaService } from './../src/prisma/prisma.service';
import { ValidationQueue } from './../src/validation/validation-queue.service';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const STALLED_FAILURE_REASON = 'job stalled more than allowable limit';

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is required for e2e tests');
  }
  return url;
}

function queuePrefix(): string {
  const prefix = process.env.QUEUE_PREFIX;
  if (!prefix) {
    throw new Error('QUEUE_PREFIX is required for e2e tests');
  }
  return prefix;
}

describe('A job BullMQ fails without ever running it (e2e)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let validationQueue: ValidationQueue;
  let stageQueue: Queue;
  let deadLetterQueue: Queue;
  let redis: Redis;
  const ownerIds: string[] = [];

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);

    prisma = app.get(PrismaService);
    validationQueue = app.get(ValidationQueue);
    redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
    const options = {
      connection: { url: redisUrl(), maxRetriesPerRequest: null },
      prefix: queuePrefix(),
    };
    stageQueue = new Queue(PipelineStage.VALIDATION, options);
    deadLetterQueue = new Queue(
      dlqQueueName(PipelineStage.VALIDATION),
      options,
    );
  });

  afterEach(async () => {
    await app.close();
    await prisma.$connect();
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await prisma.$disconnect();
    ownerIds.length = 0;
    await stageQueue.obliterate({ force: true });
    await stageQueue.close();
    await deadLetterQueue.obliterate({ force: true });
    await deadLetterQueue.close();
    await redis.quit();
  });

  async function seedInvoiceAwaitingValidation(): Promise<Invoice> {
    const ownerId = `owner-${randomUUID()}`;
    ownerIds.push(ownerId);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'invoice.pdf',
        fileSizeBytes: 100,
        status: InvoiceStatus.DATA_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'synthetic invoice text',
        textCharCount: 22,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  // BullMQ can fail a stalled job before process() with attemptsMade still at 1.
  async function enqueueAJobThatHasStalledPastItsLimit(
    invoice: Invoice,
  ): Promise<string> {
    const jobId = lifecycleJobIdFor(
      PipelineStage.VALIDATION,
      invoice.id,
      invoice.storageKey,
    );
    await stageQueue.pause();
    await validationQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });
    await redis.hset(
      `${queuePrefix()}:${PipelineStage.VALIDATION}:${jobId}`,
      'defa',
      STALLED_FAILURE_REASON,
    );
    await stageQueue.resume();
    return jobId;
  }

  it('hard-fails the invoice and dead-letters the job instead of leaving it in flight', async () => {
    const invoice = await seedInvoiceAwaitingValidation();

    const jobId = await enqueueAJobThatHasStalledPastItsLimit(invoice);

    const failed = await waitForStatus(
      prisma,
      invoice.id,
      InvoiceStatus.FAILED,
      10_000,
    );
    expect(failed.failureCode).toBe('validation_retries_exhausted');

    const deadLettered = await deadLetterQueue.getJob(jobId);
    expect(deadLettered?.data).toMatchObject({
      invoiceId: invoice.id,
      failureReason: STALLED_FAILURE_REASON,
    });
  });
});
