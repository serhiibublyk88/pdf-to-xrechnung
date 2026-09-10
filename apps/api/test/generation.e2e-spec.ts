import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Invoice, InvoiceStatus, SourceType } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildValidRawExtractedInvoiceData } from '../src/data-extraction/raw-extracted-invoice.fixture';
import type {
  RawExtractedInvoiceData,
  VatCategoryCode,
} from '@pdf-to-xrechnung/contracts';
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createOwnerSession } from './fixtures/owner-session';
import { waitForStatus } from './support/wait-for-status';
import { listenOnLoopback } from './support/listen-on-loopback';

const validParsedData = buildValidRawExtractedInvoiceData;

describe('XRechnung generation and KoSIT conformance (e2e)', () => {
  jest.setTimeout(15_000);

  let seedModule: TestingModule;
  let prisma: PrismaService;
  let app: INestApplication<App> | null;
  const ownerIds: string[] = [];

  beforeAll(async () => {
    seedModule = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    prisma = seedModule.get(PrismaService);
    await prisma.$connect();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    await prisma.invoice.deleteMany({ where: { ownerId: { in: ownerIds } } });
    ownerIds.length = 0;
  });

  afterAll(async () => {
    await seedModule.close();
  });

  async function seedInvoice(
    ownerId: string,
    parsedData: RawExtractedInvoiceData,
    status: InvoiceStatus = InvoiceStatus.GENERATING,
  ): Promise<Invoice> {
    const invoice = await prisma.invoice.create({
      data: {
        ownerId,
        fileHash: randomUUID(),
        storageKey: randomUUID(),
        originalFilename: 'invoice.pdf',
        fileSizeBytes: 100,
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
        promptVersion: 'v1',
        rawResponse: '{}',
        parsedData,
        durationMs: 1,
      },
    });
    return invoice;
  }

  async function startApplication(): Promise<void> {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  }

  async function ownerSessionForSeed(): Promise<{
    ownerId: string;
    cookie: string;
  }> {
    await startApplication();
    if (!app) {
      throw new Error('Expected the application to be running');
    }
    const session = await createOwnerSession(app);
    await app?.close();
    app = null;
    return session;
  }

  it('maps a GENERATING invoice to XRechnung UBL, gets a KoSIT-clean result, and serves it for download', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const invoice = await seedInvoice(session.ownerId, validParsedData());

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.format).toBe('XRECHNUNG_UBL');
    expect(document.isValid).toBe(true);
    expect(document.xml).toContain('<cbc:ID>RE-2026-001</cbc:ID>');

    if (!app) throw new Error('Expected the application to be running');
    const response = await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', session.cookie)
      .expect(200);

    expect(response.headers['content-type']).toContain('application/xml');
    expect(response.headers['content-disposition']).toContain(
      `xrechnung-${invoice.id}.xml`,
    );
    expect(response.text).toContain('<cbc:ID>RE-2026-001</cbc:ID>');
  });

  it('maps a reverse-charge (VAT category AE) invoice to XRechnung UBL and gets a KoSIT-clean result', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.vatRate = '0';
    parsedData.buyer.vatId = 'DE811907980';
    parsedData.vatBreakdown = [
      {
        rate: '0',
        base: '100.00',
        amount: '0.00',
        category: 'AE',
        exemptionReason: 'Reverse charge',
      },
    ];
    parsedData.vatTotal = '0.00';
    parsedData.grossTotal = '100.00';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.isValid).toBe(true);
    expect(document.xml).toContain('<cbc:ID>AE</cbc:ID>');
    expect(document.xml).toContain(
      '<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>',
    );
  });

  it('maps an intra-community supply (VAT category K) invoice with a deliver-to country, per BR-IC-12', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.vatRate = '0';
    parsedData.buyer.countryCode = 'FR';
    parsedData.buyer.vatId = 'FR40303265045';
    parsedData.vatBreakdown = [
      {
        rate: '0',
        base: '100.00',
        amount: '0.00',
        category: 'K',
        exemptionReason: 'Intra-community supply',
      },
    ];
    parsedData.vatTotal = '0.00';
    parsedData.grossTotal = '100.00';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.isValid).toBe(true);
    expect(document.xml).toContain('<cbc:ID>K</cbc:ID>');
    const deliveryBlock = /<cac:Delivery>[\s\S]*?<\/cac:Delivery>/.exec(
      document.xml,
    )?.[0];
    expect(deliveryBlock).toContain(
      '<cbc:IdentificationCode>FR</cbc:IdentificationCode>',
    );
  });

  it.each([
    {
      category: 'G' as VatCategoryCode,
      exemptionReason: 'Export outside the EU',
      buyer: { countryCode: 'US', vatId: null },
      expectedXml: ['<cbc:ID>G</cbc:ID>'],
    },
    {
      category: 'E' as VatCategoryCode,
      exemptionReason: 'Kleinunternehmerregelung nach § 19 UStG',
      buyer: null,
      expectedXml: [
        '<cbc:ID>E</cbc:ID>',
        '<cbc:TaxExemptionReason>Kleinunternehmerregelung nach § 19 UStG</cbc:TaxExemptionReason>',
      ],
    },
    {
      category: 'Z' as VatCategoryCode,
      exemptionReason: null,
      buyer: null,
      expectedXml: ['<cbc:ID>Z</cbc:ID>'],
    },
  ])(
    'maps a $category VAT category invoice to a KoSIT-clean result',
    async ({ category, exemptionReason, buyer, expectedXml }) => {
      const session = await ownerSessionForSeed();
      ownerIds.push(session.ownerId);
      const parsedData = validParsedData();
      const [lineItem] = parsedData.lineItems;
      if (!lineItem) throw new Error('Expected a line item');
      lineItem.vatRate = '0';
      if (buyer) {
        parsedData.buyer.countryCode = buyer.countryCode;
        parsedData.buyer.vatId = buyer.vatId;
      }
      parsedData.vatBreakdown = [
        {
          rate: '0',
          base: '100.00',
          amount: '0.00',
          category,
          exemptionReason,
        },
      ];
      parsedData.vatTotal = '0.00';
      parsedData.grossTotal = '100.00';
      const invoice = await seedInvoice(session.ownerId, parsedData);

      await startApplication();
      await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

      const document = await prisma.generatedDocument.findFirstOrThrow({
        where: { invoiceId: invoice.id },
      });
      expect(document.isValid).toBe(true);
      for (const fragment of expectedXml) {
        expect(document.xml).toContain(fragment);
      }
    },
  );

  it('recovers an already-claimed GENERATING_DOCUMENT invoice with no job behind it and lets it reach READY', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const invoice = await seedInvoice(
      session.ownerId,
      validParsedData(),
      InvoiceStatus.GENERATING_DOCUMENT,
    );

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.isValid).toBe(true);
  });

  it('routes an unmappable line unit to NEEDS_REVIEW with a mapping finding, without calling KoSIT', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.unit = 'Sack';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.NEEDS_REVIEW, 10_000);

    const mappingFinding = await prisma.validationResult.findFirstOrThrow({
      where: { invoiceId: invoice.id, rule: 'mapping.line_unit' },
    });
    expect(mappingFinding.passed).toBe(false);
    expect(
      await prisma.generatedDocument.count({
        where: { invoiceId: invoice.id },
      }),
    ).toBe(0);
  });

  it('keeps existing validation findings when a mapping rejection follows a clean validation pass', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.unit = 'Sack';
    const invoice = await seedInvoice(session.ownerId, parsedData);
    await prisma.validationResult.createMany({
      data: [
        {
          invoiceId: invoice.id,
          rule: 'mandatory.party_street',
          field: 'seller.address.street',
          severity: 'WARNING',
          passed: false,
          message: 'Seller street is missing.',
        },
        {
          invoiceId: invoice.id,
          rule: 'arithmetic.gross',
          field: 'grossTotal',
          severity: 'ERROR',
          passed: true,
          message: 'Gross total matches the expected amount.',
        },
      ],
    });

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.NEEDS_REVIEW, 10_000);

    const findings = await prisma.validationResult.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { rule: 'asc' },
    });
    expect(findings.map((finding) => finding.rule)).toEqual([
      'arithmetic.gross',
      'mandatory.party_street',
      'mapping.line_unit',
    ]);
  });

  it('maps the delivery date and the seller BIC into the document KoSIT accepts', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    parsedData.sellerBic = 'DEUTDEFF';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.xml).toContain(
      `<cbc:ActualDeliveryDate>${parsedData.deliveryDate ?? ''}</cbc:ActualDeliveryDate>`,
    );
    expect(document.xml).toContain('<cbc:ID>DEUTDEFF</cbc:ID>');
  });

  it('generates a valid document from a German VAT ID printed in lower case', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    parsedData.seller.vatId = 'de136695976';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.xml).toContain(
      '<cbc:CompanyID>DE136695976</cbc:CompanyID>',
    );
  });

  it('routes a KoSIT rejection to NEEDS_REVIEW with a finding naming the rule the validator objected to', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    parsedData.seller.vatId = 'QQ136695976';
    const invoice = await seedInvoice(session.ownerId, parsedData);
    await prisma.validationResult.create({
      data: {
        invoiceId: invoice.id,
        rule: 'mandatory.party_street',
        field: 'seller.address.street',
        severity: 'WARNING',
        passed: false,
        message: 'Seller street is missing.',
      },
    });

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.NEEDS_REVIEW, 10_000);

    const rejection = await prisma.validationResult.findFirstOrThrow({
      where: { invoiceId: invoice.id, rule: 'kosit.BR-CO-09' },
    });
    expect(rejection.severity).toBe('ERROR');
    expect(rejection.passed).toBe(false);
    expect(rejection.message).toContain('BR-CO-09');
    expect(
      await prisma.validationResult.count({
        where: { invoiceId: invoice.id, rule: 'mandatory.party_street' },
      }),
    ).toBe(1);

    const document = await prisma.generatedDocument.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    expect(document.isValid).toBe(false);

    if (!app) throw new Error('Expected the application to be running');
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', session.cookie)
      .expect(404);
  });

  it('does not serve the document for a NEEDS_REVIEW invoice, even to its owner', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const parsedData = validParsedData();
    const [lineItem] = parsedData.lineItems;
    if (!lineItem) throw new Error('Expected a line item');
    lineItem.unit = 'Sack';
    const invoice = await seedInvoice(session.ownerId, parsedData);

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.NEEDS_REVIEW, 10_000);

    if (!app) throw new Error('Expected the application to be running');
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', session.cookie)
      .expect(404);
  });

  it('does not reveal a READY invoice exists to a different owner', async () => {
    const session = await ownerSessionForSeed();
    ownerIds.push(session.ownerId);
    const invoice = await seedInvoice(session.ownerId, validParsedData());

    await startApplication();
    await waitForStatus(prisma, invoice.id, InvoiceStatus.READY, 10_000);
    if (!app) throw new Error('Expected the application to be running');
    const otherSession = await createOwnerSession(app);
    ownerIds.push(otherSession.ownerId);
    await request(app.getHttpServer())
      .get(`/invoices/${invoice.id}/document`)
      .set('Cookie', otherSession.cookie)
      .expect(404);
  });
});
