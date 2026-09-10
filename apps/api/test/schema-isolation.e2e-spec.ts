import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from './../src/config/config.module';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';

describe('PrismaService schema routing (e2e)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  const createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({
      where: { id: { in: createdInvoiceIds } },
    });
    await module.close();
  });

  it('writes model rows into the configured schema and never into public', async () => {
    const schema = process.env.E2E_DATABASE_SCHEMA;
    if (!schema) {
      throw new Error('E2E_DATABASE_SCHEMA is required for this e2e run');
    }

    const marker = await prisma.invoice.create({
      data: {
        ownerId: randomUUID(),
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'marker.pdf',
        fileSizeBytes: 1,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    createdInvoiceIds.push(marker.id);

    const admin = new Client({
      connectionString: process.env.E2E_ADMIN_DATABASE_URL,
    });
    await admin.connect();
    try {
      const inTargetSchema = await admin.query(
        `SELECT 1 FROM "${schema}"."Invoice" WHERE "id" = $1`,
        [marker.id],
      );
      expect(inTargetSchema.rowCount).toBe(1);

      const inPublicSchema = await admin.query(
        'SELECT 1 FROM "public"."Invoice" WHERE "id" = $1',
        [marker.id],
      );
      expect(inPublicSchema.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
