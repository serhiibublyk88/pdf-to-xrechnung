import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { InvoiceStatus, SourceType } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { AppModule } from './../src/app.module';
import { DataExtractionQueue } from './../src/data-extraction/data-extraction-queue.service';
import {
  LLM_PROVIDER,
  LlmStatusError,
  type LlmProvider,
} from './../src/data-extraction/llm-provider.interface';
import { PrismaService } from './../src/prisma/prisma.service';
import { buildMinimalPdf } from '../evals/pdf-builders';
import { createOwnerSession } from './fixtures/owner-session';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

// The uploaded filename reaches Content-Disposition, and logs outlive the retention window.
const CUSTOMER_FILENAME = 'Rechnung-Mustermann-GmbH.pdf';
const provider: LlmProvider = {
  name: 'privacy-test',
  model: 'privacy-test-v1',
  extract: () =>
    Promise.reject(
      new LlmStatusError(`Provider echoed ${CUSTOMER_FILENAME}`, 413),
    ),
};

describe('Request logging privacy (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let loggedLines: string[];
  const ownerIds: string[] = [];

  beforeAll(async () => {
    loggedLines = [];
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        loggedLines.push(chunk.toString());
        return true;
      });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await app.close();
    jest.restoreAllMocks();
  });

  it('never writes the uploaded filename to a request log line', async () => {
    const session = await createOwnerSession(app);
    ownerIds.push(session.ownerId);
    const upload = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', session.cookie)
      .attach(
        'file',
        buildMinimalPdf('Rechnung RE-2026-001'),
        CUSTOMER_FILENAME,
      )
      .expect(202);
    const { id } = upload.body as { id: string };

    loggedLines.length = 0;
    await request(app.getHttpServer())
      .get(`/invoices/${id}/source`)
      .set('Cookie', session.cookie)
      .expect(200);

    const sourceRequestLog = loggedLines.find((line) =>
      line.includes(`/invoices/${id}/source`),
    );
    expect(sourceRequestLog).toBeDefined();
    expect(sourceRequestLog).toContain('"content-disposition":"[Redacted]"');
    expect(sourceRequestLog).not.toContain('Mustermann');
    expect(loggedLines.join('\n')).not.toContain('Mustermann');
  });

  it('serializes an untrusted provider failure without its customer filename', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: CUSTOMER_FILENAME,
        fileSizeBytes: 100,
        status: InvoiceStatus.TEXT_READY,
        sourceType: SourceType.NATIVE,
        extractedText: 'Rechnung RE-2026-001 Gesamtbetrag 119,00 EUR',
        textCharCount: 46,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    loggedLines.length = 0;
    await app.get(DataExtractionQueue).enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    await waitForStatus(prisma, invoice.id, InvoiceStatus.FAILED, 10_000);

    const failureLog = loggedLines.find(
      (line) =>
        line.includes('Data extraction failed') && line.includes(invoice.id),
    );
    expect(failureLog).toBeDefined();
    const entry = z
      .object({ err: z.unknown() })
      .parse(JSON.parse(failureLog ?? ''));
    expect(entry.err).toEqual({ type: 'LlmStatusError', status: 413 });
    expect(loggedLines.join('\n')).not.toContain(CUSTOMER_FILENAME);

    const stageEventLog = loggedLines.find(
      (line) =>
        line.includes('"msg":"Pipeline stage finished"') &&
        line.includes(invoice.id),
    );
    expect(stageEventLog).toBeDefined();
    const stageEvent = JSON.parse(stageEventLog ?? '') as Record<
      string,
      unknown
    >;
    const PINO_ENVELOPE_KEYS = [
      'level',
      'time',
      'pid',
      'hostname',
      'context',
      'msg',
    ];
    const stageEventCustomKeys = Object.keys(stageEvent)
      .filter((key) => !PINO_ENVELOPE_KEYS.includes(key))
      .sort();
    expect(stageEventCustomKeys).toEqual(
      ['attempt', 'durationMs', 'invoiceId', 'outcome', 'stage'].sort(),
    );
    expect(stageEvent.outcome).toBe('failed');
    expect(typeof stageEvent.durationMs).toBe('number');
  });
});
