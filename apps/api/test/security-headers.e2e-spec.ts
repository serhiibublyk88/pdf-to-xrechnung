import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Invoice, InvoiceStatus, Severity, SourceType } from '@prisma/client';
import request from 'supertest';
import { z } from 'zod';
import { MAX_LINE_ITEMS, MAX_TEXT_LENGTH } from '@pdf-to-xrechnung/contracts';
import type {
  LineItem,
  RawExtractedInvoiceData,
} from '@pdf-to-xrechnung/contracts';
import { createApp } from '../src/main';
import { buildValidRawExtractedInvoiceData } from '../src/data-extraction/raw-extracted-invoice.fixture';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE_SERVICE } from '../src/storage/storage.interface';
import type { StorageService } from '../src/storage/storage.interface';
import { buildMinimalPdf } from '../evals/pdf-builders';
import { createOwnerSession } from './fixtures/owner-session';
import { listenOnLoopback } from './support/listen-on-loopback';

const ReviewDetailSchema = z.object({
  lifecycleToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

function largeLineItem(index: number): LineItem {
  return {
    position: index,
    description: `Dienstleistung ${String(index).padStart(4, '0')} ${'x'.repeat(
      MAX_TEXT_LENGTH - 20,
    )}`,
    quantity: '1',
    unit: 'Stück',
    unitPrice: '123.45',
    netAmount: '123.45',
    vatRate: '19',
    vatExemptionReason: null,
  };
}

function buildOversizedCorrectedData(
  lineItemCount: number,
): RawExtractedInvoiceData {
  const base = buildValidRawExtractedInvoiceData();
  return {
    ...base,
    invoiceNumber: null,
    lineItems: Array.from({ length: lineItemCount }, (_, index) =>
      largeLineItem(index + 1),
    ),
  };
}

function expectSecurityHeaders(
  headers: Record<string, string | string[] | undefined>,
) {
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toBeUndefined();
  expect(headers['cross-origin-embedder-policy']).toBeUndefined();
}

describe('Security headers and JSON body limit (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let ownerId: string;
  let sessionCookie: string;
  const ownerIds: string[] = [];
  const storedKeys: string[] = [];
  const sourcePdf = buildMinimalPdf('source invoice PDF');
  const sourcePdfHash = createHash('sha256').update(sourcePdf).digest('hex');

  beforeEach(async () => {
    app = await createApp();
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

  async function seedReviewableInvoice(): Promise<Invoice> {
    const extractedData = buildValidRawExtractedInvoiceData();
    extractedData.invoiceNumber = null;
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
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
    return invoice;
  }

  it('sets the security header set on a JSON route', async () => {
    const response = await request(app.getHttpServer())
      .get('/invoices')
      .set('Cookie', sessionCookie)
      .expect(200);

    expectSecurityHeaders(response.headers);
  });

  it('sets the same security header set on the PDF source route', async () => {
    const invoice = await seedReviewableInvoice();

    const response = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/source`)
      .set('Cookie', sessionCookie)
      .expect(200);

    expectSecurityHeaders(response.headers);
    expect(response.headers['content-type']).toContain('application/pdf');
  });

  it('accepts a valid correction payload above the framework default', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const { lifecycleToken } = ReviewDetailSchema.parse(reviewResponse.body);

    const correctedData = buildOversizedCorrectedData(MAX_LINE_ITEMS);
    const payloadSize = Buffer.byteLength(
      JSON.stringify({ lifecycleToken, correctedData }),
      'utf8',
    );
    expect(payloadSize).toBeGreaterThan(100 * 1024);
    expect(payloadSize).toBeLessThan(5 * 1024 * 1024);

    const response = await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken, correctedData });

    expect(response.status).toBe(202);
  });

  it('rejects a correction payload above the explicit limit with a real 413, no leaked internal text', async () => {
    const invoice = await seedReviewableInvoice();
    const reviewResponse = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .expect(200);
    const { lifecycleToken } = ReviewDetailSchema.parse(reviewResponse.body);

    const correctedData = buildOversizedCorrectedData(6_000);
    const payloadSize = Buffer.byteLength(
      JSON.stringify({ lifecycleToken, correctedData }),
      'utf8',
    );
    expect(payloadSize).toBeGreaterThan(5 * 1024 * 1024);

    const response = await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/review`)
      .set('Cookie', sessionCookie)
      .send({ lifecycleToken, correctedData });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      statusCode: 413,
      message: 'Payload Too Large',
    });
  });
});
