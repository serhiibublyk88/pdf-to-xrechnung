import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, Prisma, Severity, SourceType } from '@prisma/client';
import { ConfigModule } from './../src/config/config.module';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InvoiceStateMachine } from './../src/queue/invoice-state-machine';
import { withBlockedInsert } from './support/fault-injection';

describe('InvoiceStateMachine transitions under real concurrency (e2e)', () => {
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let stateMachine: InvoiceStateMachine;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [InvoiceStateMachine],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
    stateMachine = moduleFixture.get(InvoiceStateMachine);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await moduleFixture.close();
  });

  it('lets exactly one of two racing transitions win, with a read that matches what it wrote', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'race.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.UPLOADED,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const attempt = () =>
      stateMachine.transition({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.EXTRACTING_TEXT,
      });

    const outcomes = await Promise.all([attempt(), attempt()]);

    expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'lost')).toHaveLength(1);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.EXTRACTING_TEXT);
  });

  it('lets exactly one correction claim a review lifecycle', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'review-race.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.NEEDS_REVIEW,
        sourceType: SourceType.NATIVE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const attempt = (invoiceNumber: string) =>
      stateMachine.reviewCorrection({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        expectedReviewVersion: invoice.reviewVersion,
        correctedData: { invoiceNumber },
        findings: [],
        to: InvoiceStatus.NEEDS_REVIEW,
      });

    const outcomes = await Promise.all([
      attempt('REVIEW-RACE-A'),
      attempt('REVIEW-RACE-B'),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.outcome === 'claimed'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.outcome === 'lost'),
    ).toHaveLength(1);
  });

  it('does not let a stale generation completion write after the invoice returns to review', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'generation-race.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.GENERATING_DOCUMENT,
        sourceType: SourceType.NATIVE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(
      stateMachine.rejectGeneration({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        findings: [
          {
            rule: 'mapping.schema',
            field: null,
            severity: Severity.ERROR,
            passed: false,
            message: 'Stored data is not mappable.',
            expected: null,
            actual: null,
          },
        ],
      }),
    ).resolves.toBe('claimed');
    await stateMachine.transition({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      from: InvoiceStatus.NEEDS_REVIEW,
      to: InvoiceStatus.GENERATING,
    });

    await expect(
      stateMachine.completeGeneration({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        to: InvoiceStatus.READY,
        document: {
          format: 'XRECHNUNG_UBL',
          xml: '<stale-document/>',
          isValid: true,
          kositReport: { xml: '<stale-report/>' },
        },
        findings: [],
      }),
    ).resolves.toBe('lost');
    expect(
      await prisma.generatedDocument.count({
        where: { invoiceId: invoice.id },
      }),
    ).toBe(0);
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    ).toMatchObject({ status: InvoiceStatus.GENERATING });
  });

  it('rejects a legal transition to FAILED with no failure, leaving the row untouched', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'no-failure.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.EXTRACTING_TEXT,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(
      stateMachine.transition({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        from: InvoiceStatus.EXTRACTING_TEXT,
        to: InvoiceStatus.FAILED,
      }),
    ).rejects.toThrow();

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.EXTRACTING_TEXT);
    expect(stored.failureCode).toBeNull();
  });

  it('does not transition an expired lifecycle even when its id and storage key still match', async () => {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'expired-race.pdf',
        fileSizeBytes: 10,
        status: InvoiceStatus.UPLOADED,
        sourceType: SourceType.UNKNOWN,
        expiresAt: new Date(Date.now() - 1),
      },
    });

    await expect(
      stateMachine.transition({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.EXTRACTING_TEXT,
      }),
    ).resolves.toBe('lost');
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    ).toMatchObject({ status: InvoiceStatus.UPLOADED });
  });
});

describe('InvoiceStateMachine multi-table rollback under real PostgreSQL failure (e2e)', () => {
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let stateMachine: InvoiceStateMachine;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [InvoiceStateMachine],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
    stateMachine = moduleFixture.get(InvoiceStateMachine);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await moduleFixture.close();
  });

  function newInvoiceData(
    overrides: Partial<Prisma.InvoiceCreateInput> = {},
  ): Prisma.InvoiceCreateInput {
    const ownerId = randomUUID();
    ownerIds.push(ownerId);
    return {
      ownerId,
      fileHash: randomUUID(),
      storageKey: randomUUID(),
      originalFilename: 'rollback.pdf',
      fileSizeBytes: 10,
      sourceType: SourceType.NATIVE,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    };
  }

  it('rolls back completeValidation entirely when the new validation results fail to insert', async () => {
    const invoice = await prisma.invoice.create({
      data: newInvoiceData({ status: InvoiceStatus.VALIDATING }),
    });
    const oldFinding = await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'synthetic.old',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message: 'synthetic pre-existing finding',
        expected: null,
        actual: null,
      },
    });

    await withBlockedInsert(prisma, 'ValidationResult', () =>
      expect(
        stateMachine.completeValidation({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
          to: InvoiceStatus.NEEDS_REVIEW,
          validationResults: [
            {
              rule: 'synthetic.new',
              field: null,
              severity: Severity.ERROR,
              passed: false,
              message: 'synthetic new finding',
              expected: null,
              actual: null,
            },
          ],
        }),
      ).rejects.toThrow(),
    );

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.VALIDATING);
    const findings = await prisma.validationResult.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(findings.map((finding) => finding.id)).toEqual([oldFinding.id]);
  });

  it('rolls back reviewCorrection entirely when the replacement findings fail to insert', async () => {
    const oldReviewedAt = new Date('2026-08-01T00:00:00.000Z');
    const invoice = await prisma.invoice.create({
      data: newInvoiceData({
        status: InvoiceStatus.NEEDS_REVIEW,
        reviewedData: { invoiceNumber: 'OLD-1' },
        reviewedAt: oldReviewedAt,
      }),
    });
    const oldFinding = await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'synthetic.old',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message: 'synthetic pre-existing finding',
        expected: null,
        actual: null,
      },
    });
    const oldDocument = await prisma.generatedDocument.create({
      data: {
        invoiceId: invoice.id,
        format: 'XRECHNUNG_UBL',
        xml: '<old-document/>',
        isValid: false,
        kositReport: { xml: '<old-report/>' },
      },
    });

    await withBlockedInsert(prisma, 'ValidationResult', () =>
      expect(
        stateMachine.reviewCorrection({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
          expectedReviewVersion: invoice.reviewVersion,
          correctedData: { invoiceNumber: 'NEW-1' },
          findings: [
            {
              rule: 'synthetic.new',
              field: null,
              severity: Severity.ERROR,
              passed: false,
              message: 'synthetic new finding',
              expected: null,
              actual: null,
            },
          ],
          to: InvoiceStatus.GENERATING,
        }),
      ).rejects.toThrow(),
    );

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.NEEDS_REVIEW);
    expect(stored.reviewedData).toEqual({ invoiceNumber: 'OLD-1' });
    expect(stored.reviewedAt?.toISOString()).toBe(oldReviewedAt.toISOString());
    const findings = await prisma.validationResult.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(findings.map((finding) => finding.id)).toEqual([oldFinding.id]);
    const documents = await prisma.generatedDocument.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(documents.map((document) => document.id)).toEqual([oldDocument.id]);
  });

  it('rolls back rejectGeneration entirely when the replacement findings fail to insert', async () => {
    const invoice = await prisma.invoice.create({
      data: newInvoiceData({ status: InvoiceStatus.GENERATING_DOCUMENT }),
    });
    const validationFinding = await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'mandatory.invoice_number',
        field: null,
        severity: Severity.ERROR,
        passed: true,
        message: 'synthetic validation finding',
        expected: null,
        actual: null,
      },
    });
    const oldMappingFinding = await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'mapping.old',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message: 'synthetic old mapping finding',
        expected: null,
        actual: null,
      },
    });

    await withBlockedInsert(prisma, 'ValidationResult', () =>
      expect(
        stateMachine.rejectGeneration({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
          findings: [
            {
              rule: 'mapping.new',
              field: null,
              severity: Severity.ERROR,
              passed: false,
              message: 'synthetic new mapping finding',
              expected: null,
              actual: null,
            },
          ],
        }),
      ).rejects.toThrow(),
    );

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.GENERATING_DOCUMENT);
    const findings = await prisma.validationResult.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(findings.map((finding) => finding.id)).toEqual([
      validationFinding.id,
      oldMappingFinding.id,
    ]);
  });

  it('rolls back completeGeneration entirely when the document fails to insert', async () => {
    const invoice = await prisma.invoice.create({
      data: newInvoiceData({ status: InvoiceStatus.GENERATING_DOCUMENT }),
    });
    const oldKositFinding = await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'kosit.old',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message: 'synthetic old kosit finding',
        expected: null,
        actual: null,
      },
    });

    await withBlockedInsert(prisma, 'GeneratedDocument', () =>
      expect(
        stateMachine.completeGeneration({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
          to: InvoiceStatus.READY,
          document: {
            format: 'XRECHNUNG_UBL',
            xml: '<new-document/>',
            isValid: true,
            kositReport: { xml: '<new-report/>' },
          },
          findings: [],
        }),
      ).rejects.toThrow(),
    );

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.status).toBe(InvoiceStatus.GENERATING_DOCUMENT);
    const findings = await prisma.validationResult.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(findings.map((finding) => finding.id)).toEqual([oldKositFinding.id]);
    expect(
      await prisma.generatedDocument.count({
        where: { invoiceId: invoice.id },
      }),
    ).toBe(0);
  });
});
