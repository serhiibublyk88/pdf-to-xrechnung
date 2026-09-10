import 'dotenv/config';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Invoice, InvoiceStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../src/config/env.schema';
import { CleanupService } from '../src/cleanup/cleanup.service';
import { ConfigModule } from '../src/config/config.module';
import { DataExtractionQueue } from '../src/data-extraction/data-extraction-queue.service';
import { TextExtractionQueue } from '../src/extraction/text-extraction-queue.service';
import { GenerationQueue } from '../src/generation/generation-queue.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InvoiceStateMachine } from '../src/queue/invoice-state-machine';
import { dlqQueueName, PipelineStage } from '../src/queue/pipeline-stage';
import { ReviewService } from '../src/review/review.service';
import { LocalStorage } from '../src/storage/local-storage';
import { STORAGE_SERVICE } from '../src/storage/storage.interface';
import type { StorageService } from '../src/storage/storage.interface';
import { ValidationQueue } from '../src/validation/validation-queue.service';

class ControlledStorage implements StorageService {
  private failuresRemaining = 0;

  constructor(private readonly localStorage: LocalStorage) {}

  async initialize(): Promise<void> {
    await this.localStorage.onModuleInit();
  }

  failDeletes(count: number): void {
    this.failuresRemaining = count;
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    await this.localStorage.save(storageKey, data);
  }

  async read(storageKey: string): Promise<Buffer> {
    return this.localStorage.read(storageKey);
  }

  async delete(storageKey: string): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('storage is unavailable');
    }
    await this.localStorage.delete(storageKey);
  }

  async exists(storageKey: string): Promise<boolean> {
    return this.localStorage.exists(storageKey);
  }
}

describe('Stored-file deletion recovery (e2e)', () => {
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let storage: ControlledStorage;
  let reviewService: ReviewService;
  let cleanupService: CleanupService;
  const ownerIds: string[] = [];
  const storageKeys: string[] = [];

  beforeAll(async () => {
    const queue = { clean: (): Promise<never[]> => Promise.resolve([]) };
    const deadLetterQueue = {
      clean: (): Promise<never[]> => Promise.resolve([]),
      getJob: (): Promise<undefined> => Promise.resolve(undefined),
    };
    const stageQueue = {
      removeDeadLetter: (): Promise<void> => Promise.resolve(),
    };
    const logger = {
      error: (): void => undefined,
      info: (): void => undefined,
      setContext: (): void => undefined,
    };

    moduleFixture = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [
        ReviewService,
        CleanupService,
        { provide: InvoiceStateMachine, useValue: {} },
        { provide: TextExtractionQueue, useValue: stageQueue },
        { provide: DataExtractionQueue, useValue: stageQueue },
        { provide: ValidationQueue, useValue: stageQueue },
        { provide: GenerationQueue, useValue: stageQueue },
        {
          provide: STORAGE_SERVICE,
          inject: [ConfigService],
          useFactory: (
            configService: ConfigService<Env, true>,
          ): ControlledStorage =>
            new ControlledStorage(new LocalStorage(configService)),
        },
        {
          provide: SchedulerRegistry,
          useValue: { addInterval: jest.fn(), deleteInterval: jest.fn() },
        },
        { provide: PinoLogger, useValue: logger },
        {
          provide: getQueueToken(PipelineStage.TEXT_EXTRACTION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
          useValue: deadLetterQueue,
        },
        {
          provide: getQueueToken(PipelineStage.DATA_EXTRACTION),
          useValue: queue,
        },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.DATA_EXTRACTION)),
          useValue: deadLetterQueue,
        },
        { provide: getQueueToken(PipelineStage.VALIDATION), useValue: queue },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.VALIDATION)),
          useValue: deadLetterQueue,
        },
        { provide: getQueueToken(PipelineStage.GENERATION), useValue: queue },
        {
          provide: getQueueToken(dlqQueueName(PipelineStage.GENERATION)),
          useValue: deadLetterQueue,
        },
      ],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    storage = moduleFixture.get<ControlledStorage>(STORAGE_SERVICE);
    await storage.initialize();
    reviewService = moduleFixture.get(ReviewService);
    cleanupService = moduleFixture.get(CleanupService);
  });

  afterEach(async () => {
    const keys = storageKeys.splice(0);
    storage.failDeletes(0);
    await Promise.all(keys.map((storageKey) => storage.delete(storageKey)));
    await prisma.pendingStorageDeletion.deleteMany({
      where: { storageKey: { in: keys } },
    });
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    ownerIds.length = 0;
  });

  afterAll(async () => {
    await moduleFixture.close();
  });

  async function seedInvoice(): Promise<Invoice> {
    const ownerId = randomUUID();
    const storageKey = randomUUID();
    const storedFile = Buffer.from('stored invoice');
    ownerIds.push(ownerId);
    storageKeys.push(storageKey);
    await storage.save(storageKey, storedFile);
    return prisma.invoice.create({
      data: {
        ownerId,
        fileHash: createHash('sha256').update(storedFile).digest('hex'),
        storageKey,
        originalFilename: 'invoice.pdf',
        fileSizeBytes: storedFile.length,
        status: InvoiceStatus.FAILED,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it('retains a durable marker through storage failures until periodic cleanup erases the file', async () => {
    const invoice = await seedInvoice();
    storage.failDeletes(2);

    await reviewService.deleteInvoice(invoice.id, invoice.ownerId);

    await expect(
      prisma.invoice.findUnique({ where: { id: invoice.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.pendingStorageDeletion.findUnique({
        where: { storageKey: invoice.storageKey },
      }),
    ).resolves.not.toBeNull();
    await expect(storage.exists(invoice.storageKey)).resolves.toBe(true);

    await cleanupService.run();

    await expect(
      prisma.pendingStorageDeletion.findUnique({
        where: { storageKey: invoice.storageKey },
      }),
    ).resolves.not.toBeNull();
    await expect(storage.exists(invoice.storageKey)).resolves.toBe(true);

    await cleanupService.run();
    await cleanupService.run();

    await expect(
      prisma.pendingStorageDeletion.findUnique({
        where: { storageKey: invoice.storageKey },
      }),
    ).resolves.toBeNull();
    await expect(storage.exists(invoice.storageKey)).resolves.toBe(false);
  });

  it('rolls back the marker when a status change invalidates a delete snapshot', async () => {
    const invoice = await seedInvoice();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.NEEDS_REVIEW },
    });
    const snapshot = await prisma.invoice.findFirst({
      where: { id: invoice.id, ownerId: invoice.ownerId },
      select: { id: true, ownerId: true, storageKey: true, status: true },
    });
    if (!snapshot) {
      throw new Error('Expected delete snapshot');
    }
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.GENERATING },
    });

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.pendingStorageDeletion.create({
          data: { storageKey: snapshot.storageKey },
        });
        const { count } = await transaction.invoice.deleteMany({
          where: {
            id: snapshot.id,
            ownerId: snapshot.ownerId,
            storageKey: snapshot.storageKey,
            status: snapshot.status,
          },
        });
        if (count === 0) {
          throw new ConflictException(
            'Invoice changed while it was being deleted',
          );
        }
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      prisma.pendingStorageDeletion.findUnique({
        where: { storageKey: invoice.storageKey },
      }),
    ).resolves.toBeNull();
    await expect(storage.exists(invoice.storageKey)).resolves.toBe(true);
  });
});
