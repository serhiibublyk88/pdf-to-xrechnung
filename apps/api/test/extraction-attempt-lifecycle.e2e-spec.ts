import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, SourceType } from '@prisma/client';
import { ConfigModule } from './../src/config/config.module';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ExtractionAttemptRunner } from './../src/data-extraction/extraction-attempt.runner';
import type {
  LlmProvider,
  RawLlmResponse,
} from './../src/data-extraction/llm-provider.interface';

function emptyParty() {
  return {
    name: null,
    street: null,
    postalCode: null,
    city: null,
    countryCode: null,
    vatId: null,
    taxNumber: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

const VALID_DATA = {
  invoiceNumber: 'RE-1',
  issueDate: '2026-01-01',
  dueDate: null,
  deliveryDate: null,
  currency: 'EUR',
  seller: emptyParty(),
  buyer: emptyParty(),
  sellerIban: null,
  sellerBic: null,
  lineItems: [],
  netTotal: null,
  vatBreakdown: [],
  vatTotal: null,
  grossTotal: null,
  paymentTerms: null,
  buyerReference: null,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ExtractionAttemptRunner lifecycle scoping (e2e)', () => {
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

  async function createInvoice(storageKey: string) {
    const invoice = await prisma.invoice.create({
      data: {
        ownerId: randomUUID(),
        status: InvoiceStatus.EXTRACTING_DATA,
        sourceType: SourceType.NATIVE,
        fileHash: randomUUID(),
        storageKey,
        originalFilename: 'invoice.pdf',
        fileSizeBytes: 100,
        extractedText: 'Rechnung Nr. RE-1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    createdInvoiceIds.push(invoice.id);
    return invoice;
  }

  it('drops a provider response as stale work when the invoice storageKey moved on while the call was in flight', async () => {
    const oldStorageKey = randomUUID();
    const invoice = await createInvoice(oldStorageKey);

    const call = deferred<RawLlmResponse>();
    const provider: LlmProvider = {
      name: 'test',
      model: 'test-model',
      extract: jest.fn(() => call.promise),
    };
    const runner = new ExtractionAttemptRunner(provider, prisma);

    const runPromise = runner.run({
      invoiceId: invoice.id,
      storageKey: oldStorageKey,
      invoiceText: invoice.extractedText ?? '',
    });

    const newStorageKey = randomUUID();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.UPLOADED, storageKey: newStorageKey },
    });

    call.resolve({
      text: JSON.stringify(VALID_DATA),
      inputTokens: 10,
      outputTokens: 5,
      truncated: false,
    });

    const outcome = await runPromise;

    expect(outcome).toEqual({ status: 'stale' });

    const attemptsForOldKey = await prisma.extractionAttempt.count({
      where: { invoiceId: invoice.id, storageKey: oldStorageKey },
    });
    expect(attemptsForOldKey).toBe(0);

    const attemptsForNewKey = await prisma.extractionAttempt.count({
      where: { invoiceId: invoice.id, storageKey: newStorageKey },
    });
    expect(attemptsForNewKey).toBe(0);
  });

  it('persists the attempt normally when the lifecycle has not moved on', async () => {
    const storageKey = randomUUID();
    const invoice = await createInvoice(storageKey);

    const provider: LlmProvider = {
      name: 'test',
      model: 'test-model',
      extract: jest.fn(() =>
        Promise.resolve({
          text: JSON.stringify(VALID_DATA),
          inputTokens: 10,
          outputTokens: 5,
          truncated: false,
        }),
      ),
    };
    const runner = new ExtractionAttemptRunner(provider, prisma);

    const outcome = await runner.run({
      invoiceId: invoice.id,
      storageKey,
      invoiceText: invoice.extractedText ?? '',
    });

    expect(outcome).toEqual({ status: 'parsed', data: VALID_DATA });

    const attempt = await prisma.extractionAttempt.findFirstOrThrow({
      where: { invoiceId: invoice.id, storageKey },
    });
    expect(attempt.parsedData).toEqual(VALID_DATA);
  });
});
