import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { InvoiceStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { buildValidRawExtractedInvoiceData } from '../data-extraction/raw-extracted-invoice.fixture';
import { DataExtractionQueue } from '../data-extraction/data-extraction-queue.service';
import { TextExtractionQueue } from '../extraction/text-extraction-queue.service';
import { GenerationQueue } from '../generation/generation-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import { DeadLetterRetryUnavailableError } from '../queue/pipeline-stage-queue';
import { ValidationQueue } from '../validation/validation-queue.service';
import { ReviewService } from './review.service';

const INVOICE_ID = 'invoice-1';
const OWNER_ID = 'owner-1';
const STORAGE_KEY = 'storage-key-1';
const SESSION_SECRET = 'test-session-secret-that-is-long-enough-for-hmac';
const REVIEW_EXPIRY = new Date('2030-08-11T12:00:00.000Z');
const REVIEWED_AT = new Date('2026-08-26T09:00:00.000Z');

function lifecycleToken(storageKey = STORAGE_KEY, reviewVersion = 0): string {
  return createHmac('sha256', SESSION_SECRET)
    .update(
      `review.${INVOICE_ID}.${OWNER_ID}.${storageKey}.${REVIEW_EXPIRY.toISOString()}.${reviewVersion}`,
    )
    .digest('hex');
}

describe('ReviewService', () => {
  let reviewService: ReviewService;
  let prisma: {
    invoice: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    pendingStorageDeletion: { create: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let stateMachine: {
    reviewCorrection: jest.Mock;
    transition: jest.Mock;
  };
  let storage: { delete: jest.Mock };
  let generationQueue: {
    enqueue: jest.Mock;
    getDeadLetter: jest.Mock;
    retryFromDlq: jest.Mock;
    removeDeadLetter: jest.Mock;
  };
  let textExtractionQueue: {
    getDeadLetter: jest.Mock;
    retryFromDlq: jest.Mock;
    removeDeadLetter: jest.Mock;
  };
  let dataExtractionQueue: {
    getDeadLetter: jest.Mock;
    retryFromDlq: jest.Mock;
    removeDeadLetter: jest.Mock;
  };
  let validationQueue: {
    getDeadLetter: jest.Mock;
    retryFromDlq: jest.Mock;
    removeDeadLetter: jest.Mock;
  };
  let logger: { error: jest.Mock; setContext: jest.Mock; warn: jest.Mock };

  beforeEach(async () => {
    logger = {
      error: jest.fn(),
      setContext: jest.fn(),
      warn: jest.fn(),
    };
    prisma = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          storageKey: STORAGE_KEY,
          expiresAt: REVIEW_EXPIRY,
          reviewedAt: null,
          reviewVersion: 0,
          status: InvoiceStatus.NEEDS_REVIEW,
        }),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      pendingStorageDeletion: {
        create: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (
        operation: (transaction: {
          invoice: { deleteMany: jest.Mock };
          pendingStorageDeletion: { create: jest.Mock };
        }) => Promise<void>,
      ) =>
        operation({
          invoice: { deleteMany: prisma.invoice.deleteMany },
          pendingStorageDeletion: {
            create: prisma.pendingStorageDeletion.create,
          },
        }),
    );
    stateMachine = {
      reviewCorrection: jest
        .fn()
        .mockResolvedValue({ outcome: 'claimed', reviewVersion: 1 }),
      transition: jest.fn().mockResolvedValue('claimed'),
    };
    generationQueue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      getDeadLetter: jest.fn().mockResolvedValue(null),
      retryFromDlq: jest.fn().mockResolvedValue(undefined),
      removeDeadLetter: jest.fn().mockResolvedValue(undefined),
    };
    textExtractionQueue = {
      getDeadLetter: jest.fn().mockResolvedValue(null),
      retryFromDlq: jest.fn().mockResolvedValue(undefined),
      removeDeadLetter: jest.fn().mockResolvedValue(undefined),
    };
    dataExtractionQueue = {
      getDeadLetter: jest.fn().mockResolvedValue(null),
      retryFromDlq: jest.fn().mockResolvedValue(undefined),
      removeDeadLetter: jest.fn().mockResolvedValue(undefined),
    };
    validationQueue = {
      getDeadLetter: jest.fn().mockResolvedValue(null),
      retryFromDlq: jest.fn().mockResolvedValue(undefined),
      removeDeadLetter: jest.fn().mockResolvedValue(undefined),
    };

    storage = { delete: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceStateMachine, useValue: stateMachine },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: GenerationQueue, useValue: generationQueue },
        { provide: TextExtractionQueue, useValue: textExtractionQueue },
        { provide: DataExtractionQueue, useValue: dataExtractionQueue },
        { provide: ValidationQueue, useValue: validationQueue },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(SESSION_SECRET) },
        },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    reviewService = module.get(ReviewService);
  });

  it('bounds how many invoices it lists for one owner', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await reviewService.list(OWNER_ID);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it('lists the failure alongside the status, so a row can name the stage that failed', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: INVOICE_ID,
        originalFilename: 'invoice.pdf',
        status: InvoiceStatus.FAILED,
        createdAt: REVIEWED_AT,
        expiresAt: REVIEW_EXPIRY,
        failureCode: 'llm_provider_error',
        failureParams: null,
      },
    ]);

    await expect(reviewService.list(OWNER_ID)).resolves.toEqual([
      {
        id: INVOICE_ID,
        originalFilename: 'invoice.pdf',
        status: InvoiceStatus.FAILED,
        createdAt: REVIEWED_AT,
        expiresAt: REVIEW_EXPIRY,
        failure: { code: 'llm_provider_error' },
      },
    ]);
  });

  it('erases the stored file and clears every stage dead letter', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      status: InvoiceStatus.FAILED,
    });

    await reviewService.deleteInvoice(INVOICE_ID, OWNER_ID);

    expect(storage.delete).toHaveBeenCalledWith(STORAGE_KEY);
    expect(prisma.pendingStorageDeletion.create).toHaveBeenCalledWith({
      data: { storageKey: STORAGE_KEY },
    });
    expect(prisma.pendingStorageDeletion.deleteMany).toHaveBeenCalledWith({
      where: { storageKey: STORAGE_KEY },
    });
    for (const queue of [
      textExtractionQueue,
      dataExtractionQueue,
      validationQueue,
      generationQueue,
    ]) {
      expect(queue.removeDeadLetter).toHaveBeenCalledWith(
        INVOICE_ID,
        STORAGE_KEY,
      );
    }
  });

  it('still reports the delete as done when erasing the file afterwards fails', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      status: InvoiceStatus.FAILED,
    });
    storage.delete.mockRejectedValue(new Error('disk is read-only'));

    await expect(
      reviewService.deleteInvoice(INVOICE_ID, OWNER_ID),
    ).resolves.toBeUndefined();
    expect(prisma.invoice.deleteMany).toHaveBeenCalled();
    expect(prisma.pendingStorageDeletion.create).toHaveBeenCalledWith({
      data: { storageKey: STORAGE_KEY },
    });
    expect(prisma.pendingStorageDeletion.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to delete an invoice a worker still holds', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      status: InvoiceStatus.EXTRACTING_DATA,
    });

    await expect(
      reviewService.deleteInvoice(INVOICE_ID, OWNER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
  });

  it('reports a conflict when the status moved between the read and the delete', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      status: InvoiceStatus.FAILED,
    });
    prisma.invoice.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      reviewService.deleteInvoice(INVOICE_ID, OWNER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('still deletes when a dead-letter queue is unreachable', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      status: InvoiceStatus.FAILED,
    });
    validationQueue.removeDeadLetter.mockRejectedValue(
      new Error('redis unavailable'),
    );

    await expect(
      reviewService.deleteInvoice(INVOICE_ID, OWNER_ID),
    ).resolves.toBeUndefined();
    expect(prisma.invoice.deleteMany).toHaveBeenCalled();
  });

  it('does not delete an invoice owned by someone else', async () => {
    prisma.invoice.findFirst.mockReset();
    prisma.invoice.findFirst.mockResolvedValue(null);

    await expect(
      reviewService.deleteInvoice(INVOICE_ID, OWNER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('persists a valid correction through the state machine and enqueues regeneration', async () => {
    const correctedData = buildValidRawExtractedInvoiceData();
    prisma.invoice.findFirst
      .mockResolvedValueOnce({
        storageKey: STORAGE_KEY,
        expiresAt: REVIEW_EXPIRY,
        reviewedAt: null,
        reviewVersion: 0,
        status: InvoiceStatus.NEEDS_REVIEW,
      })
      .mockResolvedValue(null);

    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken(),
        correctedData,
      ),
    ).resolves.toEqual({
      status: InvoiceStatus.GENERATING,
      lifecycleToken: null,
    });

    expect(stateMachine.reviewCorrection).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      expectedReviewVersion: 0,
      correctedData,
      findings: expect.any(Array) as unknown[],
      to: InvoiceStatus.GENERATING,
    });
    expect(generationQueue.enqueue).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
    });
  });

  it('keeps a correction in review when deterministic validation still finds an error', async () => {
    const correctedData = buildValidRawExtractedInvoiceData();
    correctedData.invoiceNumber = null;
    prisma.invoice.findFirst
      .mockResolvedValueOnce({
        storageKey: STORAGE_KEY,
        expiresAt: REVIEW_EXPIRY,
        reviewedAt: null,
        reviewVersion: 0,
        status: InvoiceStatus.NEEDS_REVIEW,
      })
      .mockResolvedValue({
        storageKey: STORAGE_KEY,
        expiresAt: REVIEW_EXPIRY,
        reviewedAt: REVIEWED_AT,
        reviewVersion: 1,
        status: InvoiceStatus.NEEDS_REVIEW,
      });

    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken(),
        correctedData,
      ),
    ).resolves.toEqual({
      status: InvoiceStatus.NEEDS_REVIEW,
      lifecycleToken: lifecycleToken(STORAGE_KEY, 1),
    });

    expect(stateMachine.reviewCorrection).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      expectedReviewVersion: 0,
      correctedData,
      findings: expect.any(Array) as unknown[],
      to: InvoiceStatus.NEEDS_REVIEW,
    });
    expect(generationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a malformed correction before it can replace the stored source of truth', async () => {
    await expect(
      reviewService.review(INVOICE_ID, OWNER_ID, lifecycleToken(), {
        invoiceNumber: 123,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(stateMachine.reviewCorrection).not.toHaveBeenCalled();
  });

  it('does not mutate an invoice when the review compare-and-swap no longer matches', async () => {
    stateMachine.reviewCorrection.mockResolvedValue({ outcome: 'lost' });
    prisma.invoice.findFirst
      .mockResolvedValueOnce({
        storageKey: STORAGE_KEY,
        expiresAt: REVIEW_EXPIRY,
        reviewVersion: 0,
      })
      .mockResolvedValueOnce(null);

    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken(),
        buildValidRawExtractedInvoiceData(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(generationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('does not mutate a replacement lifecycle when its review capability names an older storage key', async () => {
    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken('retired-storage-key'),
        buildValidRawExtractedInvoiceData(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(stateMachine.reviewCorrection).not.toHaveBeenCalled();
  });

  it('returns the invoice to review, through the state machine, when regeneration cannot be enqueued', async () => {
    generationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken(),
        buildValidRawExtractedInvoiceData(),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(stateMachine.transition).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      from: InvoiceStatus.GENERATING,
      to: InvoiceStatus.NEEDS_REVIEW,
    });
  });

  it('logs a rollback failure without masking the original enqueue error, when the lifecycle already moved on', async () => {
    generationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));
    stateMachine.transition.mockResolvedValue('lost');

    await expect(
      reviewService.review(
        INVOICE_ID,
        OWNER_ID,
        lifecycleToken(),
        buildValidRawExtractedInvoiceData(),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(logger.warn).toHaveBeenCalled();
  });

  it('retries the only dead-lettered stage after confirming current owner access', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
    });
    validationQueue.getDeadLetter.mockResolvedValue({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      failedAt: '2026-08-11T12:00:00.000Z',
      failureReason: 'database unavailable',
    });

    await reviewService.retryDeadLetter(INVOICE_ID, OWNER_ID);

    expect(validationQueue.retryFromDlq).toHaveBeenCalledWith(INVOICE_ID);
    expect(textExtractionQueue.retryFromDlq).not.toHaveBeenCalled();
    expect(dataExtractionQueue.retryFromDlq).not.toHaveBeenCalled();
    expect(generationQueue.retryFromDlq).not.toHaveBeenCalled();
  });

  it('does not retry when the current lifecycle has no dead letter', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
    });

    await expect(
      reviewService.retryDeadLetter(INVOICE_ID, OWNER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns the correction source and dead-letter diagnosis in the owner-scoped detail', async () => {
    const reviewedData = buildValidRawExtractedInvoiceData();
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      originalFilename: 'invoice.pdf',
      status: InvoiceStatus.NEEDS_REVIEW,
      sourceType: 'NATIVE',
      pageCount: 1,
      failureCode: null,
      failureParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      reviewedAt: new Date(),
      reviewVersion: 1,
      reviewedData,
      attempts: [],
      validations: [],
    });
    generationQueue.getDeadLetter.mockResolvedValue({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      failedAt: '2026-08-11T12:00:00.000Z',
      failureReason: 'validator unavailable',
    });

    await expect(reviewService.detail(INVOICE_ID, OWNER_ID)).resolves.toEqual(
      expect.objectContaining({
        extractedData: reviewedData,
        lifecycleToken: expect.any(String) as string,
        deadLetter: {
          stage: PipelineStage.GENERATION,
          failedAt: '2026-08-11T12:00:00.000Z',
        },
      }),
    );
  });

  it('keeps review capabilities distinct when corrections share a timestamp', async () => {
    const detail = {
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      originalFilename: 'invoice.pdf',
      status: InvoiceStatus.NEEDS_REVIEW,
      sourceType: 'NATIVE',
      pageCount: 1,
      failureCode: null,
      failureParams: null,
      expiresAt: REVIEW_EXPIRY,
      reviewedAt: REVIEWED_AT,
      reviewedData: null,
      attempts: [],
      validations: [],
    };
    prisma.invoice.findFirst
      .mockResolvedValueOnce({ ...detail, reviewVersion: 1 })
      .mockResolvedValueOnce({ ...detail, reviewVersion: 2 });

    const first = await reviewService.detail(INVOICE_ID, OWNER_ID);
    const second = await reviewService.detail(INVOICE_ID, OWNER_ID);
    if (!first || !second) {
      throw new Error('Expected review details');
    }

    expect(first.lifecycleToken).not.toBe(second.lifecycleToken);
  });

  it('keeps review detail readable and logs an unknown stored failure code', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      originalFilename: 'invoice.pdf',
      status: InvoiceStatus.FAILED,
      sourceType: 'NATIVE',
      pageCount: 1,
      failureCode: 'future_failure_code',
      failureParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      reviewedAt: null,
      reviewVersion: 0,
      reviewedData: null,
      attempts: [],
      validations: [],
    });

    await expect(reviewService.detail(INVOICE_ID, OWNER_ID)).resolves.toEqual(
      expect.objectContaining({
        status: InvoiceStatus.FAILED,
        failure: null,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `Ignoring invalid stored failure data for invoice ${INVOICE_ID}`,
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('future_failure_code'),
    );
  });

  it('reports the most recent dead letter when an earlier stage still holds one', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      originalFilename: 'invoice.pdf',
      status: InvoiceStatus.FAILED,
      sourceType: 'NATIVE',
      pageCount: 1,
      failureCode: 'generation_retries_exhausted',
      failureParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      reviewedAt: null,
      reviewVersion: 0,
      reviewedData: null,
      attempts: [],
      validations: [],
    });
    textExtractionQueue.getDeadLetter.mockResolvedValue({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      failedAt: '2026-08-11T10:00:00.000Z',
      failureReason: 'disk unavailable',
    });
    generationQueue.getDeadLetter.mockResolvedValue({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      failedAt: '2026-08-11T12:00:00.000Z',
      failureReason: 'validator unavailable',
    });

    await expect(reviewService.detail(INVOICE_ID, OWNER_ID)).resolves.toEqual(
      expect.objectContaining({
        deadLetter: {
          stage: PipelineStage.GENERATION,
          failedAt: '2026-08-11T12:00:00.000Z',
        },
      }),
    );
  });

  it('reports a retry that lost its race as a conflict rather than a server error', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
    });
    validationQueue.getDeadLetter.mockResolvedValue({
      invoiceId: INVOICE_ID,
      storageKey: STORAGE_KEY,
      failedAt: '2026-08-11T12:00:00.000Z',
      failureReason: 'database unavailable',
    });
    validationQueue.retryFromDlq.mockRejectedValue(
      new DeadLetterRetryUnavailableError(
        `A validation job for invoice ${INVOICE_ID} is still active`,
      ),
    );

    await expect(
      reviewService.retryDeadLetter(INVOICE_ID, OWNER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('withholds the review capability for an invoice that is not awaiting review', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      storageKey: STORAGE_KEY,
      originalFilename: 'invoice.pdf',
      status: InvoiceStatus.GENERATING,
      sourceType: 'NATIVE',
      pageCount: 1,
      failureCode: null,
      failureParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      reviewedAt: null,
      reviewVersion: 0,
      reviewedData: null,
      attempts: [],
      validations: [],
    });

    await expect(reviewService.detail(INVOICE_ID, OWNER_ID)).resolves.toEqual(
      expect.objectContaining({ lifecycleToken: null }),
    );
  });
});
