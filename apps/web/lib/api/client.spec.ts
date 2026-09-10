import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_REQUEST_TIMEOUT_MS,
  getInvoiceReview,
  getInvoiceStatus,
  retryDeadLetter,
  submitInvoiceReview,
} from './client';
import { deleteInvoice, listInvoices, uploadInvoice } from './home-client';
import type { RawExtractedInvoiceData } from './schemas';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), { status, headers });
}

const correctedData: RawExtractedInvoiceData = {
  invoiceNumber: '2026-0412',
  issueDate: '2026-04-12',
  dueDate: null,
  deliveryDate: null,
  currency: 'EUR',
  seller: {
    name: null,
    street: null,
    postalCode: null,
    city: null,
    countryCode: 'DE',
    vatId: null,
    taxNumber: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  buyer: {
    name: null,
    street: null,
    postalCode: null,
    city: null,
    countryCode: 'DE',
    vatId: null,
    taxNumber: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  sellerIban: null,
  sellerBic: null,
  lineItems: [
    {
      position: 1,
      description: 'Beratung',
      quantity: '2',
      unit: 'HUR',
      unitPrice: '595.00',
      netAmount: '1190.00',
      vatRate: '19',
      vatExemptionReason: null,
    },
  ],
  netTotal: '1190.00',
  vatBreakdown: [],
  vatTotal: '226.10',
  grossTotal: '1416.10',
  paymentTerms: null,
  buyerReference: null,
};

describe('requestWithSessionRetry (via getInvoiceStatus)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const statusBody = {
    id: 'inv-1',
    status: 'READY',
    sourceType: 'NATIVE',
    pageCount: 1,
    failure: null,
  };

  it('retries the original request once after a successful session refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(200, statusBody));

    const result = await getInvoiceStatus('inv-1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/invoices/inv-1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sessions');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/invoices/inv-1');
    expect(result).toEqual({ ok: true, data: statusBody });
  });

  it('stops after one retry even when the refreshed session still 401s the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(401, { message: 'Still unauthorized' }),
      );

    const result = await getInvoiceStatus('inv-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('does not retry a second time and surfaces unauthorized when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(401, { message: 'Still unauthorized' }),
      );

    const result = await getInvoiceStatus('inv-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('does not retry at all on a genuine 404', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { message: 'Not Found' }),
    );

    const result = await getInvoiceStatus('inv-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: { kind: 'not_found' } });
  });
});

describe('errorFromResponse status classification', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies 409 as conflict', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'Conflict' }));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'conflict' } });
  });

  it('classifies 413 as payload_too_large', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(413, {}));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'payload_too_large' } });
  });

  it('classifies 429 and parses the real Retry-After header', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        429,
        { statusCode: 429, message: 'Too Many Requests' },
        { 'Retry-After': '42' },
      ),
    );
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'rate_limited', retryAfterSeconds: 42 },
    });
  });

  it('falls back to 60 seconds when Retry-After is missing or unparsable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'rate_limited', retryAfterSeconds: 60 },
    });
  });

  it('classifies 400 without reading the body', async () => {
    const response = jsonResponse(400, {
      message: 'Review request has an invalid shape',
      statusCode: 400,
    });
    const jsonSpy = vi.spyOn(response, 'json');
    fetchMock.mockResolvedValueOnce(response);

    const result = await getInvoiceStatus('inv-1');

    expect(result).toEqual({ ok: false, error: { kind: 'bad_request' } });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('falls through an unclassified status (e.g. 500) to server_error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'server_error' } });
  });

  it('classifies a thrown fetch (offline) as network_error rather than propagating', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'network_error' } });
  });

  it('classifies a 200 with a body that fails schema validation as parse_error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unexpected: 'shape' }));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'parse_error' } });
  });

  it('classifies a 200 with a non-JSON body as parse_error rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await getInvoiceStatus('inv-1');
    expect(result).toEqual({ ok: false, error: { kind: 'parse_error' } });
  });

  it('classifies a review response with an invalid expiry timestamp as parse_error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'inv-1',
        originalFilename: 'invoice.pdf',
        status: 'READY',
        sourceType: 'NATIVE',
        pageCount: 1,
        failure: null,
        expiresAt: 'not-a-date',
        reviewedAt: null,
        extractedData: null,
        lifecycleToken: null,
        findings: [],
        deadLetter: null,
      }),
    );

    const result = await getInvoiceReview('inv-1');

    expect(result).toEqual({ ok: false, error: { kind: 'parse_error' } });
  });

  it('rejects a review detail whose lifecycle token contradicts its status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'inv-1',
        originalFilename: 'invoice.pdf',
        status: 'READY',
        sourceType: 'NATIVE',
        pageCount: 1,
        failure: null,
        expiresAt: '2026-08-26T02:00:00.000Z',
        reviewedAt: null,
        extractedData: null,
        lifecycleToken: 'a'.repeat(64),
        findings: [],
        deadLetter: null,
      }),
    );

    const result = await getInvoiceReview('inv-1');

    expect(result).toEqual({ ok: false, error: { kind: 'parse_error' } });
  });
});

describe('listInvoices', () => {
  it('parses a real list response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, [
        {
          id: 'inv-1',
          originalFilename: 'invoice.pdf',
          status: 'READY',
          createdAt: '2026-08-26T00:00:00.000Z',
          expiresAt: '2026-08-26T02:00:00.000Z',
          failure: null,
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listInvoices();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('request timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns network_error when a read request exceeds its timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!init?.signal) throw new Error('Expected a request abort signal');
        return new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = listInvoices();
    await vi.advanceTimersByTimeAsync(READ_REQUEST_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      ok: false,
      error: { kind: 'network_error' },
    });
  });

  it('returns network_error when the response body stalls past the timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected a request abort signal');
        const stalledBody = new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () =>
              controller.error(signal.reason),
            );
          },
        });
        return Promise.resolve(new Response(stalledBody, { status: 200 }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    let settled: unknown;
    void listInvoices().then((listed) => {
      settled = listed;
    });
    await vi.advanceTimersByTimeAsync(READ_REQUEST_TIMEOUT_MS);

    await vi.waitFor(() =>
      expect(settled).toEqual({ ok: false, error: { kind: 'network_error' } }),
    );
  });
});

describe('mutating requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads the PDF as the file form field', async () => {
    const file = new File(['pdf'], 'invoice.pdf', { type: 'application/pdf' });
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        if (!(init?.body instanceof FormData)) {
          throw new Error('Expected upload request to use FormData');
        }
        expect(init.body.get('file')).toBe(file);
        return Promise.resolve(
          jsonResponse(202, {
            id: 'inv-1',
            status: 'UPLOADED',
            deduplicated: false,
          }),
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await uploadInvoice(file);

    expect(response).toEqual({
      ok: true,
      data: { id: 'inv-1', status: 'UPLOADED', deduplicated: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invoices',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
  });

  it('retries an upload with a fresh abort signal and the same file after a session refresh', async () => {
    const file = new File(['pdf'], 'invoice.pdf', { type: 'application/pdf' });
    const uploadSignals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (input === '/api/sessions') {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (!(init?.body instanceof FormData)) {
          throw new Error('Expected the retried upload to still send FormData');
        }
        expect(init.body.get('file')).toBe(file);
        uploadSignals.push(init.signal ?? undefined);
        return Promise.resolve(
          uploadSignals.length === 1
            ? jsonResponse(401, { message: 'Unauthorized' })
            : jsonResponse(202, {
                id: 'inv-1',
                status: 'UPLOADED',
                deduplicated: false,
              }),
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await uploadInvoice(file);

    expect(response).toEqual({
      ok: true,
      data: { id: 'inv-1', status: 'UPLOADED', deduplicated: false },
    });
    expect(uploadSignals).toHaveLength(2);
    expect(uploadSignals[0]).not.toBe(uploadSignals[1]);
    expect(uploadSignals[0]?.aborted).toBe(false);
    expect(uploadSignals[1]?.aborted).toBe(false);
  });

  it('submits exactly the review body the API accepts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, { status: 'GENERATING', lifecycleToken: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await submitInvoiceReview('inv-1', {
      lifecycleToken: 'a'.repeat(64),
      correctedData,
    });

    expect(response).toEqual({
      ok: true,
      data: { status: 'GENERATING', lifecycleToken: null },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invoices/inv-1/review',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lifecycleToken: 'a'.repeat(64),
          correctedData,
        }),
      }),
    );
  });

  it('rejects a review result without the capability required by its status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, { status: 'NEEDS_REVIEW', lifecycleToken: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await submitInvoiceReview('inv-1', {
      lifecycleToken: 'a'.repeat(64),
      correctedData,
    });

    expect(response).toEqual({
      ok: false,
      error: { kind: 'parse_error' },
    });
  });

  it('deletes an invoice and accepts the empty response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await deleteInvoice('inv-1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invoices/inv-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(response).toEqual({ ok: true, data: undefined });
  });
});

describe('retryDeadLetter', () => {
  it('classifies a 204 as a successful empty result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await retryDeadLetter('inv-1');

    expect(result).toEqual({ ok: true, data: undefined });
    vi.unstubAllGlobals();
  });
});
