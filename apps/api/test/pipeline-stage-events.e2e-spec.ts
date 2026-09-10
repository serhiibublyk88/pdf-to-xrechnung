import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvoiceStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PipelineStage } from './../src/queue/pipeline-stage';
import { STORAGE_SERVICE } from './../src/storage/storage.interface';
import type { StorageService } from './../src/storage/storage.interface';
import { buildMinimalPdf } from '../evals/pdf-builders';
import { createOwnerSession } from './fixtures/owner-session';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const StageEventSchema = z.object({
  invoiceId: z.string(),
  stage: z.nativeEnum(PipelineStage),
  outcome: z.literal('completed'),
  durationMs: z.number(),
  attempt: z.number(),
});

describe('Pipeline stage completion events (e2e)', () => {
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
    }).compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const storage = app.get<StorageService>(STORAGE_SERVICE);
    const rows = await prisma.invoice.findMany({
      where: { ownerId: { in: ownerIds } },
      select: { storageKey: true },
    });
    await Promise.all(rows.map((row) => storage.delete(row.storageKey)));
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await app.close();
    jest.restoreAllMocks();
  });

  it('emits exactly one structured completion event per pipeline stage, each with a numeric duration', async () => {
    const session = await createOwnerSession(app);
    ownerIds.push(session.ownerId);
    const pdf = buildMinimalPdf(
      'Rechnungsnummer RE-2026-002 Rechnungsdatum 08.08.2026 Gesamtbetrag 100,00 EUR Verkaeufer Muster GmbH',
    );

    loggedLines.length = 0;
    const upload = await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', session.cookie)
      .attach('file', pdf, 'invoice.pdf')
      .expect(202);
    const { id } = upload.body as { id: string };

    await waitForStatus(prisma, id, InvoiceStatus.READY, 10_000);

    const stageEvents = loggedLines
      .filter(
        (line) =>
          line.includes('"msg":"Pipeline stage finished"') && line.includes(id),
      )
      .map((line) => StageEventSchema.parse(JSON.parse(line)));

    expect(stageEvents.map((event) => event.stage).sort()).toEqual(
      [
        PipelineStage.TEXT_EXTRACTION,
        PipelineStage.DATA_EXTRACTION,
        PipelineStage.VALIDATION,
        PipelineStage.GENERATION,
      ].sort(),
    );
    for (const event of stageEvents) {
      expect(event.invoiceId).toBe(id);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
