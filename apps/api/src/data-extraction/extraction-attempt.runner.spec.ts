import { ExtractionAttemptRunner } from './extraction-attempt.runner';
import type { LlmProvider, RawLlmResponse } from './llm-provider.interface';
import { RetryableLlmProviderError } from './llm-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

type ExtractMock = jest.Mock<Promise<RawLlmResponse>, [string]>;

function fakeProvider(extract: ExtractMock): LlmProvider {
  return { name: 'test', model: 'test-model', extract };
}

interface FakeAttempt {
  id: string;
  invoiceId: string;
  storageKey: string;
  data: Record<string, unknown>;
}

function fakePrisma() {
  let nextId = 0;
  let stillCurrent = true;
  const attempts: FakeAttempt[] = [];

  const updateMany = jest.fn(() =>
    Promise.resolve({ count: stillCurrent ? 1 : 0 }),
  );
  const count = jest.fn(
    ({
      where,
    }: {
      where: { invoiceId: string; storageKey: string };
    }): Promise<number> =>
      Promise.resolve(
        attempts.filter(
          (attempt) =>
            attempt.invoiceId === where.invoiceId &&
            attempt.storageKey === where.storageKey,
        ).length,
      ),
  );
  const create = jest.fn(
    ({ data }: { data: Record<string, unknown> }): Promise<FakeAttempt> => {
      nextId += 1;
      const attempt: FakeAttempt = {
        id: `attempt-${nextId}`,
        invoiceId: data.invoiceId as string,
        storageKey: data.storageKey as string,
        data,
      };
      attempts.push(attempt);
      return Promise.resolve(attempt);
    },
  );
  const update = jest.fn(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<FakeAttempt> => {
      const attempt = attempts.find((candidate) => candidate.id === where.id);
      if (!attempt) {
        throw new Error(`No attempt with id ${where.id}`);
      }
      Object.assign(attempt.data, data);
      return Promise.resolve(attempt);
    },
  );
  const transaction = jest.fn(
    (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      callback({
        invoice: { updateMany },
        extractionAttempt: { count, create },
      }),
  );

  const prisma = {
    $transaction: transaction,
    extractionAttempt: { update },
  } as unknown as PrismaService;

  return {
    prisma,
    create,
    update,
    count,
    attempts,
    setStillCurrent: (value: boolean) => {
      stillCurrent = value;
    },
  };
}

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

describe('ExtractionAttemptRunner', () => {
  function response(text: string, truncated = false): RawLlmResponse {
    return { text, inputTokens: 100, outputTokens: 50, truncated };
  }

  it('persists exactly one row and returns the parsed result on a schema-valid first response', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValue(response(JSON.stringify(VALID_DATA)));
    const { prisma, create, update, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith(
      expect.stringContaining('invoice text'),
    );
    expect(outcome).toEqual({ status: 'parsed', data: VALID_DATA });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        attemptNumber: 1,
        provider: 'test',
        model: 'test-model',
        rawResponse: JSON.stringify(VALID_DATA),
        durationMs: expect.any(Number) as number,
        inputTokens: 100,
        outputTokens: 50,
      }) as object,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: { parsedData: VALID_DATA, parseError: null },
    });
    expect(attempts[0]?.data.parsedData).toEqual(VALID_DATA);
  });

  it('persists a row before parsing even when the response is malformed', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response(JSON.stringify(VALID_DATA)));
    const { prisma, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(attempts[0]?.data.rawResponse).toBe('not json');
    expect(attempts[0]?.data.parsedData).toBeUndefined();
    expect(attempts[0]?.data.parseError).toContain('not valid JSON');
  });

  it('repairs once after malformed JSON, persisting two rows with consecutive attempt numbers', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response(JSON.stringify(VALID_DATA)));
    const { prisma, create, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(2);
    const repairPrompt = extract.mock.calls[1]?.[0];
    expect(repairPrompt).toContain('not json');
    expect(repairPrompt).toContain('not valid JSON');

    expect(create).toHaveBeenCalledTimes(2);
    expect(attempts[0]).toMatchObject({
      data: expect.objectContaining({
        attemptNumber: 1,
        rawResponse: 'not json',
      }) as object,
    });
    expect(attempts[1]).toMatchObject({
      data: expect.objectContaining({
        attemptNumber: 2,
        rawResponse: JSON.stringify(VALID_DATA),
        parsedData: VALID_DATA,
      }) as object,
    });
    expect(outcome).toEqual({ status: 'parsed', data: VALID_DATA });
  });

  it('repairs once after a schema violation and succeeds', async () => {
    const invalid = { ...VALID_DATA, invoiceNumber: 123 };
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(JSON.stringify(VALID_DATA)));
    const { prisma } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(2);
    const repairPrompt = extract.mock.calls[1]?.[0];
    expect(repairPrompt).toContain('invoiceNumber');
    expect(outcome).toEqual({ status: 'parsed', data: VALID_DATA });
  });

  it('keeps the raw response out of the returned outcome while the row keeps it in full', async () => {
    const leaky = '```json\n{"invoiceNumber":"RE-2026-0042"}';
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response(leaky))
      .mockResolvedValueOnce(response(leaky));
    const { prisma, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(JSON.stringify(outcome)).not.toContain('RE-2026-0042');
    expect(JSON.stringify(outcome)).not.toContain('`');
    expect(attempts[1]?.data.rawResponse).toBe(leaky);
  });

  it('gives up after the repair attempt also fails, spending exactly one repair call', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response('still not json'));
    const { prisma, create, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(attempts[1]?.data.rawResponse).toBe('still not json');
    expect(attempts[1]?.data.parseError).toContain('not valid JSON');
    expect(outcome).toEqual({ status: 'failed', failureKind: 'json' });
    expect(JSON.stringify(outcome)).not.toContain('still not json');
  });

  it('classifies a truncated repair response as truncated, not by its parse shape', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response('still not json', true));
    const { prisma, create, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(attempts[1]?.data.rawResponse).toBe('still not json');
    expect(attempts[1]?.data.parseError).toContain('not valid JSON');
    expect(outcome).toEqual({ status: 'failed', failureKind: 'truncated' });
    expect(JSON.stringify(outcome)).not.toContain('still not json');
  });

  it('classifies a truncated repair response as truncated even when the truncated JSON is schema-invalid', async () => {
    const schemaInvalidJson = { ...VALID_DATA, invoiceNumber: 123 };
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response(JSON.stringify(schemaInvalidJson), true));
    const { prisma, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(attempts[1]?.data.parseError).toBeDefined();
    expect(outcome).toEqual({ status: 'failed', failureKind: 'truncated' });
  });

  it('keeps a schema-valid repair a success even when the provider also flags it truncated', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response(JSON.stringify(VALID_DATA), true));
    const { prisma } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(outcome).toEqual({ status: 'parsed', data: VALID_DATA });
  });

  it('does not repair a truncated first response, and classifies it distinctly', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('{"invoiceNumber": "RE-1"', true));
    const { prisma, create } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'failed', failureKind: 'truncated' });
  });

  it('propagates a retryable provider error from the first call without persisting or repairing', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockRejectedValue(new RetryableLlmProviderError('timeout'));
    const { prisma, create } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    await expect(
      runner.run({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        invoiceText: 'invoice text',
      }),
    ).rejects.toBeInstanceOf(RetryableLlmProviderError);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('propagates a retryable provider error raised during the repair call, keeping the first row', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'))
      .mockRejectedValueOnce(new RetryableLlmProviderError('timeout'));
    const { prisma, create, attempts } = fakePrisma();
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    await expect(
      runner.run({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        invoiceText: 'invoice text',
      }),
    ).rejects.toBeInstanceOf(RetryableLlmProviderError);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(attempts[0]?.data.parseError).toContain('not valid JSON');
  });

  it('drops the response as stale work, without persisting or repairing, when the lifecycle no longer matches', async () => {
    const extract = jest
      .fn<Promise<RawLlmResponse>, [string]>()
      .mockResolvedValueOnce(response('not json'));
    const { prisma, create, update, setStillCurrent } = fakePrisma();
    setStillCurrent(false);
    const runner = new ExtractionAttemptRunner(fakeProvider(extract), prisma);

    const outcome = await runner.run({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      invoiceText: 'invoice text',
    });

    expect(outcome).toEqual({ status: 'stale' });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
