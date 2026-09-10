import { createHash, createHmac, randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, Severity, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import type { Env } from '../src/config/env.schema';
import { buildValidRawExtractedInvoiceData } from '../src/data-extraction/raw-extracted-invoice.fixture';
import {
  InvoiceFailureSchema,
  MAX_LINE_ITEMS,
  RawExtractedInvoiceDataSchema,
  ReviewResultSchema,
  type ReviewResult,
} from '@pdf-to-xrechnung/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from '../src/queue/pipeline-stage';
import type { DeadLetterJobData } from '../src/queue/pipeline-stage-queue';
import { GenerationQueue } from '../src/generation/generation-queue.service';
import { InvoiceStateMachine } from '../src/queue/invoice-state-machine';
import { OwnerSessionService } from '../src/sessions/owner-session.service';
import { STORAGE_SERVICE } from '../src/storage/storage.interface';
import type { StorageService } from '../src/storage/storage.interface';
import { buildMinimalPdf } from '../evals/pdf-builders';
import {
  createOwnerSession,
  ownerSessionFromHeaders,
} from './fixtures/owner-session';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const ReviewDetailSchema = z.object({
  id: z.string().uuid(),
  status: z.nativeEnum(InvoiceStatus),
  extractedData: z.nullable(RawExtractedInvoiceDataSchema),
  lifecycleToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

const UploadAcceptedSchema = z
  .object({
    id: z.string().uuid(),
    status: z.nativeEnum(InvoiceStatus),
    deduplicated: z.boolean(),
  })
  .strict();

const pipelineStages = [
  PipelineStage.TEXT_EXTRACTION,
  PipelineStage.DATA_EXTRACTION,
  PipelineStage.VALIDATION,
  PipelineStage.GENERATION,
];

const InvoiceListSchema = z.array(
  z.object({
    id: z.string().uuid(),
    status: z.nativeEnum(InvoiceStatus),
    failure: z.nullable(InvoiceFailureSchema),
  }),
);

function parseReviewResult(body: unknown): ReviewResult {
  const parsed = ReviewResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Review result response did not match its public contract');
  }
  return parsed.data;
}

function parseReviewDetail(body: unknown): z.infer<typeof ReviewDetailSchema> {
  const parsed = ReviewDetailSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Review detail response did not match its public contract');
  }
  return parsed.data;
}

function parseUploadAccepted(
  body: unknown,
): z.infer<typeof UploadAcceptedSchema> {
  const parsed = UploadAcceptedSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Upload response did not match its public contract');
  }
  return parsed.data;
}

function parseInvoiceList(body: unknown): z.infer<typeof InvoiceListSchema> {
  const parsed = InvoiceListSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Invoice list response did not match its public contract');
  }
  return parsed.data;
}

describe('Invoice review API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  let ownerId: string;
  let sessionCookie: string;
  const ownerIds: string[] = [];
  const storedKeys: string[] = [];
  const sourcePdf = buildMinimalPdf('source invoice PDF');
  const sourcePdfHash = createHash('sha256').update(sourcePdf).digest('hex');

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
    storage = app.get<StorageService>(STORAGE_SERVICE);
    const session = await createOwnerSession(app);
    ownerId = session.ownerId;
    sessionCookie = session.cookie;
    ownerIds.push(ownerId);
  });

  afterEach(async () => {
    await app.close();
    await prisma.$connect();
    await Promise.all(
      storedKeys.map((storageKey) => storage.delete(storageKey)),
    );
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await prisma.$disconnect();
    ownerIds.length = 0;
    storedKeys.length = 0;
  });

  async function seedReviewableInvoice(
    seedOwnerId = ownerId,
  ): Promise<Invoice> {
    const extractedData = buildValidRawExtractedInvoiceData();
    extractedData.invoiceNumber = null;
    const invoice = await prisma.invoice.create({
      data: {
        ownerId: seedOwnerId,
        fileHash: sourcePdfHash,
        storageKey: randomUUID(),
        originalFilename: 'review-source.pdf',
        fileSizeBytes: sourcePdf.length,
        status: InvoiceStatus.NEEDS_REVIEW,
        sourceType: SourceType.NATIVE,
        pageCount: 1,
        extractedText: 'synthetic source text',
        textCharCount: 21,
        reviewedData: extractedData,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await storage.save(invoice.storageKey, sourcePdf);
    storedKeys.push(invoice.storageKey);
    await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'mandatory.invoice_number',
        field: 'invoiceNumber',
        severity: Severity.ERROR,
        passed: false,
        message: 'Invoice number is required.',
      },
    });
    await prisma.generatedDocument.create({
      data: {
        invoiceId: invoice.id,
        format: 'XRECHNUNG_UBL',
        xml: '<old-document/>',
        isValid: false,
        kositReport: { xml: '<old-report/>' },
      },
    });
    return invoice;
  }

  it('persists a correction, regenerates a KoSIT-clean XML document, and serves the owner-scoped review resources', async () => {
    const invoice = await seedReviewableInvoice();

    const listResponse = await request(app.getHttpServer())
      .get('/invoices')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(parseInvoiceList(listResponse.body)).toContainEqual({
      id: invoice.id,
      status: InvoiceStatus.NEEDS_REVIEW,
      failure: null,
    });
    expect(listResponse.headers['cache-control']).toBe('no-store');

    const statusResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(statusResponse.headers['cache-control']).toBe('no-store');

    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const review = parseReviewDetail(reviewResponse.body);
    expect(review.extractedData?.invoiceNumber).toBeNull();
    expect(reviewResponse.headers['cache-control']).toBe('no-store');
    if (!review.lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }

    const sourceResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/source`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(sourceResponse.headers['content-type']).toContain('application/pdf');
    expect(sourceResponse.headers['content-disposition']).toContain('inline');
    expect(sourceResponse.headers['cache-control']).toBe('no-store');
    if (!Buffer.isBuffer(sourceResponse.body)) {
      throw new Error('Expected the source response body to be a Buffer');
    }
    expect(sourceResponse.body.equals(sourcePdf)).toBe(true);

    const otherSession = await createOwnerSession(app);
    ownerIds.push(otherSession.ownerId);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', otherSession.cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/source`)
      .set('Cookie', otherSession.cookie)
      .expect(404);

    const correctedData = buildValidRawExtractedInvoiceData();
    correctedData.invoiceNumber = 'CORRECTED-2026-001';
    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken: review.lifecycleToken, correctedData })
      .expect(202);

    const completed = await waitForStatus(
      prisma,
      invoice.id,
      InvoiceStatus.READY,
      15_000,
    );
    expect(completed.reviewedData).toEqual(correctedData);
    expect(
      await prisma.validationResult.findFirst({
        where: {
          invoiceId: invoice.id,
          rule: 'mandatory.invoice_number',
          passed: true,
        },
      }),
    ).not.toBeNull();
    const documents = await prisma.generatedDocument.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.isValid).toBe(true);
    expect(documents[0]?.xml).toContain('<cbc:ID>CORRECTED-2026-001</cbc:ID>');

    const documentResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(documentResponse.headers['content-type']).toContain(
      'application/xml',
    );
    expect(documentResponse.headers['cache-control']).toBe('no-store');
    expect(documentResponse.text).toContain(
      '<cbc:ID>CORRECTED-2026-001</cbc:ID>',
    );
  });

  it('does not let an old review capability mutate a replacement lifecycle', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const review = parseReviewDetail(reviewResponse.body);
    if (!review.lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }

    const replacementStorageKey = randomUUID();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { storageKey: replacementStorageKey },
    });

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: review.lifecycleToken,
        correctedData: buildValidRawExtractedInvoiceData(),
      })
      .expect(409);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.storageKey).toBe(replacementStorageKey);
    expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(stored.reviewedData).toEqual(invoice.reviewedData);
  });

  it('stops a second tab overwriting a correction that already landed, and hands the first tab a token that still works', async () => {
    const invoice = await seedReviewableInvoice();
    const detailResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const staleToken = parseReviewDetail(detailResponse.body).lifecycleToken;
    if (!staleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }

    const incomplete = buildValidRawExtractedInvoiceData();
    incomplete.invoiceNumber = null;
    const accepted = await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken: staleToken, correctedData: incomplete })
      .expect(202);
    const refreshedToken = parseReviewResult(accepted.body).lifecycleToken;

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: staleToken,
        correctedData: buildValidRawExtractedInvoiceData(),
      })
      .expect(409);

    expect(refreshedToken).not.toBe(staleToken);
    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: refreshedToken,
        correctedData: buildValidRawExtractedInvoiceData(),
      })
      .expect(202);
  });

  it('allows one concurrent correction to claim a review capability', async () => {
    const invoice = await seedReviewableInvoice();
    const detailResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const lifecycleToken = parseReviewDetail(
      detailResponse.body,
    ).lifecycleToken;
    if (!lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }

    const firstCorrection = buildValidRawExtractedInvoiceData();
    firstCorrection.invoiceNumber = null;
    firstCorrection.paymentTerms = 'FIRST-CORRECTION';
    const secondCorrection = buildValidRawExtractedInvoiceData();
    secondCorrection.invoiceNumber = null;
    secondCorrection.paymentTerms = 'SECOND-CORRECTION';

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .send({ lifecycleToken, correctedData: firstCorrection }),
      request(app.getHttpServer())
        .post(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .send({ lifecycleToken, correctedData: secondCorrection }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);

    const accepted = responses.find((response) => response.status === 202);
    if (!accepted) {
      throw new Error('Expected one correction to be accepted');
    }
    const reviewResult = parseReviewResult(accepted.body);
    expect(reviewResult).toMatchObject({ status: InvoiceStatus.NEEDS_REVIEW });
    expect(reviewResult.lifecycleToken).not.toBe(lifecycleToken);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.reviewVersion).toBe(1);
    expect([firstCorrection, secondCorrection]).toContainEqual(
      stored.reviewedData,
    );
  });

  it('rejects a review capability minted for a different owner, even with a well-formed token', async () => {
    const invoice = await seedReviewableInvoice();
    const otherSession = await createOwnerSession(app);
    ownerIds.push(otherSession.ownerId);

    const configService: ConfigService<Env, true> = app.get(ConfigService);
    const sessionSecret: string = configService.get('SESSION_SECRET');
    const tokenForOwner = createHmac('sha256', sessionSecret)
      .update(
        `review.${invoice.id}.${ownerId}.${invoice.storageKey}.${invoice.expiresAt.toISOString()}.${invoice.reviewVersion}`,
      )
      .digest('hex');

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', otherSession.cookie)
      .send({
        lifecycleToken: tokenForOwner,
        correctedData: buildValidRawExtractedInvoiceData(),
      })
      .expect(404);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.reviewedData).toEqual(invoice.reviewedData);
  });

  it('rejects a correction submitted while the invoice is already generating', async () => {
    const invoice = await seedReviewableInvoice();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.GENERATING },
    });

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: '0'.repeat(64),
        correctedData: buildValidRawExtractedInvoiceData(),
      })
      .expect(409);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.GENERATING);
    expect(stored.reviewedData).toEqual(invoice.reviewedData);
  });

  it('regenerates a correction submitted while the rejected generation job is still finishing', async () => {
    const invoice = await seedReviewableInvoice();
    const stateMachine = app.get(InvoiceStateMachine);
    const rejectGeneration = stateMachine.rejectGeneration.bind(stateMachine);
    let releaseRejectedRun: () => void = () => {};
    const rejectedRunHeld = new Promise<void>((resolve) => {
      releaseRejectedRun = resolve;
    });
    jest
      .spyOn(stateMachine, 'rejectGeneration')
      .mockImplementationOnce(async (rejection) => {
        const outcome = await rejectGeneration(rejection);
        await rejectedRunHeld;
        return outcome;
      });

    async function submitCorrection(
      correctedData: ReturnType<typeof buildValidRawExtractedInvoiceData>,
    ): Promise<void> {
      const reviewResponse = await request(app.getHttpServer())
        .get(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .expect(200);
      const { lifecycleToken } = parseReviewDetail(reviewResponse.body);
      if (!lifecycleToken) {
        throw new Error(
          'Expected a review capability for a reviewable invoice',
        );
      }
      await request(app.getHttpServer())
        .post(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .send({ lifecycleToken, correctedData })
        .expect(202);
    }

    const unmappable = buildValidRawExtractedInvoiceData();
    const [lineItem] = unmappable.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.unit = 'Sack';
    const corrected = buildValidRawExtractedInvoiceData();
    corrected.invoiceNumber = 'CORRECTED-AFTER-REJECTION';
    try {
      await submitCorrection(unmappable);
      await waitForStatus(
        prisma,
        invoice.id,
        InvoiceStatus.NEEDS_REVIEW,
        15_000,
      );
      await submitCorrection(corrected);
    } finally {
      releaseRejectedRun();
    }

    const completed = await waitForStatus(
      prisma,
      invoice.id,
      InvoiceStatus.READY,
      15_000,
    );
    expect(completed.reviewedData).toEqual(corrected);
    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.xml).toContain(
      '<cbc:ID>CORRECTED-AFTER-REJECTION</cbc:ID>',
    );
  }, 30_000);

  it('erases the row, the PDF and every dead letter, and frees the hash for a fresh upload', async () => {
    const invoice = await seedReviewableInvoice();
    const deadLetters = pipelineStages.map((stage) => ({
      jobId: lifecycleJobIdFor(stage, invoice.id, invoice.storageKey),
      queue: app.get<Queue<DeadLetterJobData>>(
        getQueueToken(dlqQueueName(stage)),
      ),
    }));
    await Promise.all(
      deadLetters.map(({ jobId, queue }) =>
        queue.add(
          'dead-letter',
          {
            invoiceId: invoice.id,
            storageKey: invoice.storageKey,
            failedAt: new Date().toISOString(),
            failureReason: null,
          },
          { jobId },
        ),
      ),
    );

    const heldHashResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', sourcePdf, 'review-source.pdf')
      .expect(202);
    expect(parseUploadAccepted(heldHashResponse.body)).toMatchObject({
      id: invoice.id,
      deduplicated: true,
    });

    await request(app.getHttpServer())
      .delete(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(204);

    expect(
      await prisma.invoice.findUnique({ where: { id: invoice.id } }),
    ).toBeNull();
    await expect(storage.read(invoice.storageKey)).rejects.toBeDefined();
    for (const { jobId, queue } of deadLetters) {
      expect(await queue.getJob(jobId)).toBeUndefined();
    }

    const freshResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', sourcePdf, 'review-source.pdf')
      .expect(202);
    const fresh = parseUploadAccepted(freshResponse.body);
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.id).not.toBe(invoice.id);
    const { storageKey } = await prisma.invoice.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { storageKey: true },
    });
    storedKeys.push(storageKey);

    await request(app.getHttpServer())
      .delete(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(404);
  });

  it('refuses to delete a lifecycle a worker still holds', async () => {
    const invoice = await seedReviewableInvoice();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.EXTRACTING_DATA },
    });

    await request(app.getHttpServer())
      .delete(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(409);

    expect(
      await prisma.invoice.findUnique({ where: { id: invoice.id } }),
    ).not.toBeNull();
  });

  it("does not let one owner delete another owner's invoice", async () => {
    const invoice = await seedReviewableInvoice(randomUUID());

    await request(app.getHttpServer())
      .delete(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(404);

    expect(
      await prisma.invoice.findUnique({ where: { id: invoice.id } }),
    ).not.toBeNull();
  });

  it('requires a session before accepting a correction and rejects a malformed review request', async () => {
    const invoice = await seedReviewableInvoice();

    await request(app.getHttpServer()).get('/invoices').expect(401);
    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ correctedData: buildValidRawExtractedInvoiceData() })
      .expect(400);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(stored.reviewedData).toEqual(invoice.reviewedData);
  });

  it('rejects a non-hex lifecycleToken and an unexpected body key, then accepts the same request without them', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const review = parseReviewDetail(reviewResponse.body);
    if (!review.lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }
    const correctedData = buildValidRawExtractedInvoiceData();

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken: 'z'.repeat(64), correctedData })
      .expect(400);
    let stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(stored.reviewedData).toEqual(invoice.reviewedData);

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: review.lifecycleToken,
        correctedData,
        unexpectedKey: 'not part of the contract',
      })
      .expect(400);
    stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(stored.reviewedData).toEqual(invoice.reviewedData);

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken: review.lifecycleToken, correctedData })
      .expect(202);
  });

  it('rejects a correction above the line-item limit without consuming its capability', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const review = parseReviewDetail(reviewResponse.body);
    if (!review.lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }
    const correctedData = buildValidRawExtractedInvoiceData();
    const lineItem = correctedData.lineItems[0];
    if (!lineItem) {
      throw new Error('Expected the correction fixture to include a line item');
    }
    correctedData.lineItems = Array.from(
      { length: MAX_LINE_ITEMS + 1 },
      (_, index) => ({ ...lineItem, position: index + 1 }),
    );

    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken: review.lifecycleToken, correctedData })
      .expect(400);

    const rejected = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(rejected.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(rejected.reviewVersion).toBe(0);
    expect(rejected.reviewedData).toEqual(invoice.reviewedData);
    expect(
      await prisma.validationResult.count({
        where: { invoiceId: invoice.id },
      }),
    ).toBe(1);
    expect(
      await prisma.generatedDocument.count({
        where: { invoiceId: invoice.id },
      }),
    ).toBe(1);

    const maximumData = buildValidRawExtractedInvoiceData();
    const maximumLineItem = maximumData.lineItems[0];
    if (!maximumLineItem) {
      throw new Error('Expected the correction fixture to include a line item');
    }
    maximumData.lineItems = Array.from(
      { length: MAX_LINE_ITEMS },
      (_, index) => ({ ...maximumLineItem, position: index + 1 }),
    );

    const maximumResponse = await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({
        lifecycleToken: review.lifecycleToken,
        correctedData: maximumData,
      })
      .expect(202);
    expect(parseReviewResult(maximumResponse.body).status).toBe('NEEDS_REVIEW');

    const accepted = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(
      RawExtractedInvoiceDataSchema.parse(accepted.reviewedData).lineItems,
    ).toHaveLength(MAX_LINE_ITEMS);
  });

  it('returns a queue failure to review so the same correction remains retryable', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const review = parseReviewDetail(reviewResponse.body);
    if (!review.lifecycleToken) {
      throw new Error('Expected a review capability for a reviewable invoice');
    }

    await app.close();
    const failingGenerationQueue = {
      enqueue: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      getDeadLetter: jest.fn().mockResolvedValue(null),
      retryFromDlq: jest.fn().mockResolvedValue(undefined),
      reconcileFailedJobs: jest.fn().mockResolvedValue(0),
      requeueStranded: jest.fn().mockResolvedValue(true),
      inFlightStatuses: [
        InvoiceStatus.GENERATING,
        InvoiceStatus.GENERATING_DOCUMENT,
      ],
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GenerationQueue)
      .useValue(failingGenerationQueue)
      .compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
    storage = app.get<StorageService>(STORAGE_SERVICE);

    const correctedData = buildValidRawExtractedInvoiceData();
    let lifecycleToken = review.lifecycleToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app.getHttpServer())
        .post(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .send({ lifecycleToken, correctedData })
        .expect(503);
      const stored = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
      expect(stored.reviewedData).toEqual(correctedData);

      const refreshed = await request(app.getHttpServer())
        .get(`/invoices/${invoice.id}/review`)
        .set('Cookie', sessionCookie)
        .expect(200);
      const refreshedToken = parseReviewDetail(refreshed.body).lifecycleToken;
      if (!refreshedToken) {
        throw new Error('Expected the invoice to still be correctable');
      }
      lifecycleToken = refreshedToken;
    }

    expect(failingGenerationQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('keeps an invoice reachable across a session refresh even when it was uploaded near the original session expiry', async () => {
    const ownerSessions = app.get(OwnerSessionService);
    const retentionMs =
      Number(process.env.RETENTION_HOURS ?? '2') * 60 * 60 * 1000;
    const nearExpiryCookieHeader = ownerSessions.createSetCookieHeader(
      Date.now() - retentionMs + 1500,
    );
    const nearExpirySession = ownerSessionFromHeaders({
      'set-cookie': [nearExpiryCookieHeader],
    });
    ownerIds.push(nearExpirySession.ownerId);
    const invoice = await seedReviewableInvoice(nearExpirySession.ownerId);

    const refreshResponse = await request(app.getHttpServer())
      .post('/sessions')
      .set('Cookie', nearExpirySession.cookie)
      .expect(204);
    const refreshedSession = ownerSessionFromHeaders(refreshResponse.headers);
    expect(refreshedSession.ownerId).toBe(nearExpirySession.ownerId);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}`)
      .set('Cookie', nearExpirySession.cookie)
      .expect(401);

    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', refreshedSession.cookie)
      .expect(200);
  }, 10_000);

  it('makes every invoice endpoint 404 once expiresAt has passed, even before cleanup runs', async () => {
    const extractedData = buildValidRawExtractedInvoiceData();
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'expired-source.pdf',
        fileSizeBytes: sourcePdf.length,
        status: InvoiceStatus.READY,
        sourceType: SourceType.NATIVE,
        pageCount: 1,
        extractedText: 'synthetic source text',
        textCharCount: 21,
        reviewedData: extractedData,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await storage.save(invoice.storageKey, sourcePdf);
    storedKeys.push(invoice.storageKey);
    await prisma.generatedDocument.create({
      data: {
        invoiceId: invoice.id,
        format: 'XRECHNUNG_UBL',
        xml: '<expired-document/>',
        isValid: true,
        kositReport: { xml: '<expired-report/>' },
      },
    });

    const listResponse = await request(app.getHttpServer())
      .get('/invoices')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(
      parseInvoiceList(listResponse.body).some(
        (item) => item.id === invoice.id,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}`)
      .set('Cookie', sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/source`)
      .set('Cookie', sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(404);
  });
});
