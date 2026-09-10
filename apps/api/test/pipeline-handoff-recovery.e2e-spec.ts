import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { App } from 'supertest/types';
import { buildValidRawExtractedInvoiceData } from '../src/data-extraction/raw-extracted-invoice.fixture';
import { AppModule } from './../src/app.module';
import { ConfigModule } from './../src/config/config.module';
import {
  DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  DataExtractionQueue,
} from './../src/data-extraction/data-extraction-queue.service';
import { GenerationQueue } from './../src/generation/generation-queue.service';
import { PROMPT_VERSION } from './../src/data-extraction/prompt';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InvoiceStateMachine } from './../src/queue/invoice-state-machine';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { publishNextStage } from './../src/queue/pipeline-stage-queue';
import { QueueModule } from './../src/queue/queue.module';
import { STORAGE_SERVICE } from './../src/storage/storage.interface';
import type { StorageService } from './../src/storage/storage.interface';
import {
  TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
  TextExtractionQueue,
} from './../src/extraction/text-extraction-queue.service';
import { buildMinimalPdf } from '../evals/pdf-builders';
import {
  VALIDATION_RETRY_EXHAUSTED_FAILURE,
  ValidationQueue,
} from './../src/validation/validation-queue.service';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const validParsedData = buildValidRawExtractedInvoiceData;

function buildQueueModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      QueueModule,
      BullModule.registerQueue(
        { name: PipelineStage.TEXT_EXTRACTION },
        { name: dlqQueueName(PipelineStage.TEXT_EXTRACTION) },
        { name: PipelineStage.DATA_EXTRACTION },
        { name: dlqQueueName(PipelineStage.DATA_EXTRACTION) },
        { name: PipelineStage.VALIDATION },
        { name: dlqQueueName(PipelineStage.VALIDATION) },
        { name: PipelineStage.GENERATION },
        { name: dlqQueueName(PipelineStage.GENERATION) },
      ),
    ],
    providers: [
      TextExtractionQueue,
      DataExtractionQueue,
      ValidationQueue,
      GenerationQueue,
      {
        provide: PinoLogger,
        useValue: { error: jest.fn(), setContext: jest.fn() },
      },
    ],
  }).compile();
}

describe('publishNextStage recovery under real PostgreSQL + Redis (e2e)', () => {
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let stateMachine: InvoiceStateMachine;
  let textExtractionQueue: TextExtractionQueue;
  let dataExtractionQueue: DataExtractionQueue;
  let validationQueue: ValidationQueue;
  let generationQueue: GenerationQueue;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    moduleFixture = await buildQueueModule();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
    stateMachine = moduleFixture.get(InvoiceStateMachine);
    textExtractionQueue = moduleFixture.get(TextExtractionQueue);
    dataExtractionQueue = moduleFixture.get(DataExtractionQueue);
    validationQueue = moduleFixture.get(ValidationQueue);
    generationQueue = moduleFixture.get(GenerationQueue);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await moduleFixture.close();
  });

  async function seedInvoice(status: InvoiceStatus): Promise<Invoice> {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'handoff.pdf',
        fileSizeBytes: 10,
        status,
        sourceType: SourceType.NATIVE,
        extractedText: 'synthetic invoice text',
        textCharCount: 22,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  describe('text-extraction -> data-extraction (own in-flight status EXTRACTING_TEXT)', () => {
    it('rolls back to EXTRACTING_TEXT and rethrows on a definite rejection', async () => {
      const invoice = await seedInvoice(InvoiceStatus.TEXT_READY);
      const enqueueError = new Error('synthetic redis outage');
      jest
        .spyOn(dataExtractionQueue, 'enqueue')
        .mockRejectedValueOnce(enqueueError);

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: textExtractionQueue,
          nextQueue: dataExtractionQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).rejects.toThrow('synthetic redis outage');

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.EXTRACTING_TEXT);
    });

    it('does not rethrow, and does not move the row backward, when the rollback loses to a data-extraction worker that already claimed it', async () => {
      const invoice = await seedInvoice(InvoiceStatus.TEXT_READY);
      jest
        .spyOn(dataExtractionQueue, 'enqueue')
        .mockImplementationOnce(async () => {
          await stateMachine.transition({
            invoiceId: invoice.id,
            storageKey: invoice.storageKey,
            from: InvoiceStatus.TEXT_READY,
            to: InvoiceStatus.EXTRACTING_DATA,
          });
          throw new Error('synthetic response loss');
        });

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: textExtractionQueue,
          nextQueue: dataExtractionQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.EXTRACTING_DATA);
    });

    it('does not rethrow when the lifecycle expired before the rollback ran', async () => {
      const invoice = await seedInvoice(InvoiceStatus.TEXT_READY);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      jest
        .spyOn(dataExtractionQueue, 'enqueue')
        .mockRejectedValueOnce(new Error('synthetic redis outage'));

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: textExtractionQueue,
          nextQueue: dataExtractionQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.TEXT_READY);
    });
  });

  describe('data-extraction -> validation (own in-flight status EXTRACTING_DATA)', () => {
    it('rolls back to EXTRACTING_DATA and rethrows on a definite rejection', async () => {
      const invoice = await seedInvoice(InvoiceStatus.DATA_READY);
      const enqueueError = new Error('synthetic redis outage');
      jest
        .spyOn(validationQueue, 'enqueue')
        .mockRejectedValueOnce(enqueueError);

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: dataExtractionQueue,
          nextQueue: validationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).rejects.toThrow('synthetic redis outage');

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.EXTRACTING_DATA);
    });

    it('does not rethrow, and does not move the row backward, when the rollback loses to a validation worker that already claimed it', async () => {
      const invoice = await seedInvoice(InvoiceStatus.DATA_READY);
      jest
        .spyOn(validationQueue, 'enqueue')
        .mockImplementationOnce(async () => {
          await stateMachine.transition({
            invoiceId: invoice.id,
            storageKey: invoice.storageKey,
            from: InvoiceStatus.DATA_READY,
            to: InvoiceStatus.VALIDATING,
          });
          throw new Error('synthetic response loss');
        });

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: dataExtractionQueue,
          nextQueue: validationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.VALIDATING);
    });

    it('does not rethrow when the lifecycle expired before the rollback ran', async () => {
      const invoice = await seedInvoice(InvoiceStatus.DATA_READY);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      jest
        .spyOn(validationQueue, 'enqueue')
        .mockRejectedValueOnce(new Error('synthetic redis outage'));

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: dataExtractionQueue,
          nextQueue: validationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.DATA_READY);
    });
  });

  describe('validation -> generation (own in-flight status VALIDATING)', () => {
    it('rolls back to VALIDATING and rethrows on a definite rejection', async () => {
      const invoice = await seedInvoice(InvoiceStatus.GENERATING);
      const enqueueError = new Error('synthetic redis outage');
      jest
        .spyOn(generationQueue, 'enqueue')
        .mockRejectedValueOnce(enqueueError);

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: validationQueue,
          nextQueue: generationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).rejects.toThrow('synthetic redis outage');

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.VALIDATING);
    });

    it('does not rethrow, and does not move the row backward, when the rollback loses to a generation worker that already claimed it', async () => {
      const invoice = await seedInvoice(InvoiceStatus.GENERATING);
      jest
        .spyOn(generationQueue, 'enqueue')
        .mockImplementationOnce(async () => {
          await stateMachine.transition({
            invoiceId: invoice.id,
            storageKey: invoice.storageKey,
            from: InvoiceStatus.GENERATING,
            to: InvoiceStatus.GENERATING_DOCUMENT,
          });
          throw new Error('synthetic response loss');
        });

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: validationQueue,
          nextQueue: generationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.GENERATING_DOCUMENT);
    });

    it('does not rethrow when the lifecycle expired before the rollback ran', async () => {
      const invoice = await seedInvoice(InvoiceStatus.GENERATING);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      jest
        .spyOn(generationQueue, 'enqueue')
        .mockRejectedValueOnce(new Error('synthetic redis outage'));

      await expect(
        publishNextStage({
          stateMachine,
          ownQueue: validationQueue,
          nextQueue: generationQueue,
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
      ).resolves.toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row.status).toBe(InvoiceStatus.GENERATING);
    });
  });
});

describe('Forward-handoff recovery through the real worker pipeline (e2e)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication<App>;
  let prisma: PrismaService;
  const ownerIds: string[] = [];

  // The app boots before seeding, so startup reconciliation cannot be what recovers the invoice.
  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await app.close();
    await prisma.$connect();
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await prisma.$disconnect();
    ownerIds.length = 0;
  });

  async function seedClaimedInvoice(status: InvoiceStatus): Promise<Invoice> {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'handoff.pdf',
        fileSizeBytes: 10,
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
        promptVersion: PROMPT_VERSION,
        rawResponse: '{}',
        parsedData: validParsedData(),
        durationMs: 1,
      },
    });
    return invoice;
  }

  async function seedClaimedTextInvoice(): Promise<Invoice> {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const storageKey = randomUUID();
    const storage = app.get<StorageService>(STORAGE_SERVICE);
    await storage.save(
      storageKey,
      buildMinimalPdf(
        'Rechnungsnummer RE-2026-007 Rechnungsdatum 08.08.2026 Gesamtbetrag 100,00 EUR Verkaeufer Muster GmbH',
      ),
    );
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey,
        originalFilename: 'handoff.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.EXTRACTING_TEXT,
        sourceType: SourceType.NATIVE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it('reaches READY after one rejected text-extraction to data-extraction enqueue, without an app restart', async () => {
    const invoice = await seedClaimedTextInvoice();
    const textExtractionQueue = app.get(TextExtractionQueue);
    const dataExtractionQueue = app.get(DataExtractionQueue);
    jest
      .spyOn(dataExtractionQueue, 'enqueue')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('synthetic redis outage')),
      );

    await textExtractionQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.READY,
      15_000,
    );
    expect(finished.status).toBe(InvoiceStatus.READY);
  });

  it('dead-letters the text-extraction job under its own retry-exhausted code when data-extraction enqueue keeps failing', async () => {
    const invoice = await seedClaimedTextInvoice();
    const textExtractionQueue = app.get(TextExtractionQueue);
    const dataExtractionQueue = app.get(DataExtractionQueue);
    jest
      .spyOn(dataExtractionQueue, 'enqueue')
      .mockRejectedValue(new Error('synthetic redis outage'));

    await textExtractionQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.FAILED,
      20_000,
    );
    expect(finished.failureCode).toBe(
      TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE.code,
    );

    const dlq = app.get<Queue>(
      getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
    );
    const jobId = lifecycleJobIdFor(
      PipelineStage.TEXT_EXTRACTION,
      invoice.id,
      invoice.storageKey,
    );
    expect(await dlq.getJob(jobId)).toBeDefined();
  });

  it('reaches READY after one rejected data-extraction to validation enqueue, without an app restart', async () => {
    const invoice = await seedClaimedInvoice(InvoiceStatus.EXTRACTING_DATA);
    const validationQueue = app.get(ValidationQueue);
    const dataExtractionQueue = app.get(DataExtractionQueue);
    jest
      .spyOn(validationQueue, 'enqueue')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('synthetic redis outage')),
      );

    await dataExtractionQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.READY,
      15_000,
    );
    expect(finished.status).toBe(InvoiceStatus.READY);
  });

  it('dead-letters the data-extraction job under its own retry-exhausted code when validation enqueue keeps failing', async () => {
    const invoice = await seedClaimedInvoice(InvoiceStatus.EXTRACTING_DATA);
    const validationQueue = app.get(ValidationQueue);
    const dataExtractionQueue = app.get(DataExtractionQueue);
    jest
      .spyOn(validationQueue, 'enqueue')
      .mockRejectedValue(new Error('synthetic redis outage'));

    await dataExtractionQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.FAILED,
      20_000,
    );
    expect(finished.failureCode).toBe(
      DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE.code,
    );

    const dlq = app.get<Queue>(
      getQueueToken(dlqQueueName(PipelineStage.DATA_EXTRACTION)),
    );
    const jobId = lifecycleJobIdFor(
      PipelineStage.DATA_EXTRACTION,
      invoice.id,
      invoice.storageKey,
    );
    expect(await dlq.getJob(jobId)).toBeDefined();
  });

  it('reaches READY after one rejected validation to generation enqueue, without an app restart', async () => {
    const invoice = await seedClaimedInvoice(InvoiceStatus.VALIDATING);
    const generationQueue = app.get(GenerationQueue);
    const validationQueue = app.get(ValidationQueue);
    jest
      .spyOn(generationQueue, 'enqueue')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('synthetic redis outage')),
      );

    await validationQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.READY,
      15_000,
    );
    expect(finished.status).toBe(InvoiceStatus.READY);
  });

  it('dead-letters the validation job under its own retry-exhausted code when generation enqueue keeps failing', async () => {
    const invoice = await seedClaimedInvoice(InvoiceStatus.VALIDATING);
    const generationQueue = app.get(GenerationQueue);
    const validationQueue = app.get(ValidationQueue);
    jest
      .spyOn(generationQueue, 'enqueue')
      .mockRejectedValue(new Error('synthetic redis outage'));

    await validationQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    const finished = await waitForStatus(
      prisma,
      invoice.id,
      (status) => status === InvoiceStatus.FAILED,
      20_000,
    );
    expect(finished.failureCode).toBe(VALIDATION_RETRY_EXHAUSTED_FAILURE.code);

    const dlq = app.get<Queue>(
      getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
    );
    const jobId = lifecycleJobIdFor(
      PipelineStage.VALIDATION,
      invoice.id,
      invoice.storageKey,
    );
    expect(await dlq.getJob(jobId)).toBeDefined();
  });
});
