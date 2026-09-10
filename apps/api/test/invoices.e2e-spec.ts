import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, SourceType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { InvoiceFailureSchema } from '@pdf-to-xrechnung/contracts';
import { AppModule } from './../src/app.module';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from './../src/queue/pipeline-stage';
import { PrismaService } from './../src/prisma/prisma.service';
import { STORAGE_SERVICE } from './../src/storage/storage.interface';
import type { StorageService } from './../src/storage/storage.interface';
import { buildMinimalPdf, buildMultiPagePdf } from '../evals/pdf-builders';
import {
  PdfResourceLimitError,
  TEXT_EXTRACTOR,
} from '../src/extraction/text-extractor.interface';
import { createOwnerSession } from './fixtures/owner-session';
import { listenOnLoopback } from './support/listen-on-loopback';
import { waitForStatus } from './support/wait-for-status';

const UploadAcceptedResultSchema = z
  .object({
    id: z.string().uuid(),
    status: z.nativeEnum(InvoiceStatus),
    deduplicated: z.boolean(),
  })
  .strict();

const InvoiceStatusResultSchema = z
  .object({
    id: z.string().uuid(),
    status: z.nativeEnum(InvoiceStatus),
    sourceType: z.nativeEnum(SourceType),
    pageCount: z.number().int().nullable(),
    failure: z.nullable(InvoiceFailureSchema),
  })
  .strict();
type InvoiceStatusResult = z.infer<typeof InvoiceStatusResultSchema>;

const InvoiceDetailSchema = z.object({
  id: z.string().uuid(),
  status: z.nativeEnum(InvoiceStatus),
  deadLetter: z
    .object({
      stage: z.nativeEnum(PipelineStage),
      failedAt: z.string(),
    })
    .nullable(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Response did not match its public contract');
  }
  return parsed.data;
}

async function pollUntilTerminal(
  app: INestApplication<App>,
  sessionCookie: string,
  invoiceId: string,
  timeoutMs = 5000,
): Promise<InvoiceStatusResult> {
  await waitForStatus(
    app.get(PrismaService),
    invoiceId,
    (status) =>
      status === InvoiceStatus.READY ||
      status === InvoiceStatus.NEEDS_REVIEW ||
      status === InvoiceStatus.FAILED,
    timeoutMs,
  );
  const response = await request(app.getHttpServer())
    .get(`/invoices/${invoiceId}`)
    .set('Cookie', sessionCookie)
    .expect(200);
  return parseBody(InvoiceStatusResultSchema, response.body);
}

describe('InvoicesController (e2e)', () => {
  let app: INestApplication<App>;
  let ownerId: string;
  let sessionCookie: string;
  let trackedOwnerIds: string[];
  const pdf = buildMinimalPdf(
    'Rechnungsnummer RE-2026-001 Rechnungsdatum 08.08.2026 Gesamtbetrag 100,00 EUR Verkaeufer Muster GmbH',
  );

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    const session = await createOwnerSession(app);
    ownerId = session.ownerId;
    sessionCookie = session.cookie;
    trackedOwnerIds = [ownerId];
  });

  afterEach(async () => {
    const prisma = app.get(PrismaService);
    const storage = app.get<StorageService>(STORAGE_SERVICE);
    await app.close();
    await prisma.$connect();
    const rows = await prisma.invoice.findMany({
      where: { ownerId: { in: trackedOwnerIds } },
      select: { storageKey: true },
    });
    await Promise.all(rows.map((row) => storage.delete(row.storageKey)));
    await prisma.invoice.deleteMany({
      where: { ownerId: { in: trackedOwnerIds } },
    });
    await prisma.$disconnect();
    jest.restoreAllMocks();
  });

  it('enqueues text extraction for an uploaded PDF and caches a repeat upload', async () => {
    const firstResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const first = parseBody(UploadAcceptedResultSchema, firstResponse.body);

    expect(first).toEqual({
      id: expect.any(String) as string,
      status: InvoiceStatus.UPLOADED,
      deduplicated: false,
    });

    const finished = await pollUntilTerminal(
      app,
      sessionCookie,
      first.id,
      10_000,
    );
    expect(finished.status).toBe(InvoiceStatus.READY);
    expect(finished.sourceType).toBe('NATIVE');

    const secondResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const second = parseBody(UploadAcceptedResultSchema, secondResponse.body);

    expect(second).toEqual({
      id: first.id,
      status: InvoiceStatus.READY,
      deduplicated: true,
    });
  });

  it('refreshes the session on upload so it outlives the invoice it just accepted', async () => {
    const response = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const { id } = parseBody(UploadAcceptedResultSchema, response.body);

    const setCookie: unknown = response.headers['set-cookie'];
    if (!Array.isArray(setCookie) || typeof setCookie[0] !== 'string') {
      throw new Error('Expected the upload to refresh the session cookie');
    }
    const refreshed = /^invoice_session=([0-9a-f-]{36})\.(\d+)\./.exec(
      setCookie[0],
    );
    if (!refreshed) {
      throw new Error('Expected a parsable refreshed session cookie');
    }

    const invoice = await app.get(PrismaService).invoice.findUniqueOrThrow({
      where: { id },
      select: { expiresAt: true },
    });

    expect(refreshed[1]).toBe(ownerId);
    expect(Number(refreshed[2])).toBeGreaterThanOrEqual(
      invoice.expiresAt.getTime(),
    );
  });

  it('does not serve one owner a cache hit from another owner uploading the same bytes', async () => {
    const firstResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const first = parseBody(UploadAcceptedResultSchema, firstResponse.body);

    const otherSession = await createOwnerSession(app);
    trackedOwnerIds.push(otherSession.ownerId);
    const secondResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', otherSession.cookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const second = parseBody(UploadAcceptedResultSchema, secondResponse.body);

    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  it('rejects a PDF over the page limit before parsing it, well inside the parse timeout', async () => {
    const oversizedPdf = buildMultiPagePdf(Array<null>(31).fill(null));

    const start = Date.now();
    const uploadResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', oversizedPdf, 'invoice.pdf')
      .expect(202);
    const { id } = parseBody(UploadAcceptedResultSchema, uploadResponse.body);

    const finished = await pollUntilTerminal(app, sessionCookie, id, 5000);

    expect(Date.now() - start).toBeLessThan(5000);
    expect(finished.status).toBe(InvoiceStatus.FAILED);
    expect(finished.failure?.code).toBe('pdf_too_many_pages');
  });

  it('persists a native resource limit as a terminal public failure', async () => {
    await app.close();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TEXT_EXTRACTOR)
      .useValue({
        extract: () =>
          Promise.reject(
            new PdfResourceLimitError('PDF resource limit exceeded'),
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);

    const uploadResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const { id } = parseBody(UploadAcceptedResultSchema, uploadResponse.body);

    const finished = await pollUntilTerminal(app, sessionCookie, id);

    expect(finished.status).toBe(InvoiceStatus.FAILED);
    expect(finished.failure).toEqual({ code: 'pdf_resource_limit' });
  });

  it('logs the parse failure reason for a corrupt PDF, not just its invoice id', async () => {
    await app.close();
    const loggedErrors: Array<{ bindings: unknown; message: unknown }> = [];
    const logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: (bindings: unknown, message: unknown) => {
        loggedErrors.push({ bindings, message });
      },
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PinoLogger)
      .useValue(logger)
      .compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);

    const validPdf = buildMinimalPdf('Rechnungsnummer RE-2026-006');
    const corruptPdf = validPdf.subarray(0, Math.floor(validPdf.length / 2));

    const uploadResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', corruptPdf, 'invoice.pdf')
      .expect(202);
    const { id } = parseBody(UploadAcceptedResultSchema, uploadResponse.body);

    const finished = await pollUntilTerminal(app, sessionCookie, id);

    expect(finished.status).toBe(InvoiceStatus.FAILED);
    expect(finished.failure?.code).toBe('pdf_unreadable');

    const failureLog = loggedErrors.find(
      (entry) => entry.message === 'Text extraction failed',
    );
    expect(failureLog).toBeDefined();
    const bindings = z
      .object({
        invoiceId: z.literal(id),
        err: z.instanceof(Error),
      })
      .parse(failureLog?.bindings);
    expect(bindings.err.message).not.toBe('Text extraction failed');
    expect(bindings.err.message.length).toBeGreaterThan(0);
  });

  it('reaches a terminal status through the OCR route for an image-only invoice', async () => {
    const scannedPdf = readFileSync(
      join(__dirname, '../evals/dataset/011-scan-clean-de/invoice.pdf'),
    );

    const uploadResponse = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', scannedPdf, 'invoice.pdf')
      .expect(202);
    const { id } = parseBody(UploadAcceptedResultSchema, uploadResponse.body);

    const finished = await pollUntilTerminal(app, sessionCookie, id);

    expect(finished.status).toBe(InvoiceStatus.READY);
    expect(finished.sourceType).toBe('OCR');
    expect(finished.failure).toBeNull();
  });

  describe('GET /invoices/:id', () => {
    it('returns 404 for another owner instead of revealing the invoice exists', async () => {
      const uploadResponse = await request(app.getHttpServer())
        .post('/invoices')
        .set('Cookie', sessionCookie)
        .attach('file', pdf, 'invoice.pdf')
        .expect(202);
      const { id } = parseBody(UploadAcceptedResultSchema, uploadResponse.body);

      const otherSession = await createOwnerSession(app);
      trackedOwnerIds.push(otherSession.ownerId);
      await request(app.getHttpServer())
        .get(`/invoices/${id}`)
        .set('Cookie', otherSession.cookie)
        .expect(404);
    });

    it('returns 404 for an id that does not exist', async () => {
      await request(app.getHttpServer())
        .get(`/invoices/${randomUUID()}`)
        .set('Cookie', sessionCookie)
        .expect(404);
    });

    it('rejects a malformed session instead of querying with it', async () => {
      await request(app.getHttpServer())
        .get(`/invoices/${randomUUID()}`)
        .set('Cookie', 'invoice_session=not-a-session')
        .expect(401);
    });

    it('rejects a well-formed but forged session cookie instead of querying with it', async () => {
      const genuine =
        /^invoice_session=[0-9a-f-]{36}\.(\d+)\.([0-9a-f]{64})$/.exec(
          sessionCookie,
        );
      if (!genuine) {
        throw new Error(
          'Expected a well-formed session cookie from the fixture',
        );
      }
      const [, expiresAt, signature] = genuine;
      const forgedCookie = `invoice_session=${randomUUID()}.${expiresAt}.${signature}`;

      await request(app.getHttpServer())
        .get(`/invoices/${randomUUID()}`)
        .set('Cookie', forgedCookie)
        .expect(401);
    });

    it('rejects a request with no session', async () => {
      await request(app.getHttpServer())
        .get(`/invoices/${randomUUID()}`)
        .expect(401);
    });
  });

  it('reaches FAILED and lands in the dead-letter queue once retries are exhausted, then recovers through a real retryFromDlq', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let storageIsDown = true;
    const recoverableStorage: StorageService = {
      save: jest.fn().mockResolvedValue(undefined),
      read: jest
        .fn()
        .mockImplementation(() =>
          storageIsDown
            ? Promise.reject(new Error('disk unavailable'))
            : Promise.resolve(pdf),
        ),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    };
    await app.close();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE_SERVICE)
      .useValue(recoverableStorage)
      .compile();
    const retryApp: INestApplication<App> =
      moduleFixture.createNestApplication();
    await listenOnLoopback(retryApp);

    try {
      const response = await request(retryApp.getHttpServer())
        .post('/invoices')
        .set('Cookie', sessionCookie)
        .attach('file', pdf, 'invoice.pdf')
        .expect(202);
      const { id } = parseBody(UploadAcceptedResultSchema, response.body);

      const failed = await pollUntilTerminal(
        retryApp,
        sessionCookie,
        id,
        15_000,
      );

      expect(failed.status).toBe(InvoiceStatus.FAILED);
      expect(failed.failure).toEqual({
        code: 'text_extraction_retries_exhausted',
      });

      const dlq = retryApp.get<Queue>(
        getQueueToken(dlqQueueName(PipelineStage.TEXT_EXTRACTION)),
      );
      const invoice = await retryApp
        .get(PrismaService)
        .invoice.findUniqueOrThrow({
          where: { id },
          select: { storageKey: true },
        });
      const dlqJobId = lifecycleJobIdFor(
        PipelineStage.TEXT_EXTRACTION,
        id,
        invoice.storageKey,
      );
      expect(await dlq.getJob(dlqJobId)).toBeDefined();

      const reviewResponse = await request(retryApp.getHttpServer())
        .get(`/invoices/${id}/review`)
        .set('Cookie', sessionCookie)
        .expect(200);
      const reviewDetail = parseBody(InvoiceDetailSchema, reviewResponse.body);
      expect(reviewDetail.deadLetter).toEqual({
        stage: PipelineStage.TEXT_EXTRACTION,
        failedAt: expect.any(String) as string,
      });
      expect(JSON.stringify(reviewDetail)).not.toContain('disk unavailable');

      storageIsDown = false;
      await request(retryApp.getHttpServer())
        .post(`/invoices/${id}/dead-letter/retry`)
        .set('Cookie', sessionCookie)
        .expect(204);

      const recovered = await pollUntilTerminal(
        retryApp,
        sessionCookie,
        id,
        10_000,
      );
      expect(recovered.status).toBe(InvoiceStatus.READY);
      expect(await dlq.getJob(dlqJobId)).toBeUndefined();
    } finally {
      await retryApp.close();
      const freshModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = freshModule.createNestApplication();
      await listenOnLoopback(app);
    }
  }, 30_000);

  it('rejects a non-PDF upload', () => {
    return request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from('not a pdf'), 'invoice.pdf')
      .expect(400);
  });

  it('rejects an upload without a session', () => {
    return request(app.getHttpServer())
      .post('/invoices')
      .attach('file', pdf, 'invoice.pdf')
      .expect(401);
  });

  it('rejects an upload with a malformed session', () => {
    return request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', 'invoice_session=not-a-session')
      .attach('file', pdf, 'invoice.pdf')
      .expect(401);
  });

  it('rejects an oversized file at the multer limit, before it is buffered', async () => {
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(11 * 1024 * 1024, 'a'),
    ]);

    const response = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessionCookie)
      .attach('file', oversized, 'invoice.pdf');

    const body = response.body as { message?: unknown };

    expect(response.status).toBe(413);
    expect(typeof body.message).toBe('string');
  });
});
