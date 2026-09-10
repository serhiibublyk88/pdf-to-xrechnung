import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { ReviewWorkspace } from './review-workspace';
import type {
  InvoiceDetail,
  InvoiceFinding,
  InvoiceStatusResult,
  LineItem,
  Party,
  RawExtractedInvoiceData,
} from '@/lib/api/schemas';

vi.mock('@/lib/api/client', () => ({
  getInvoiceStatus: vi.fn(),
  getInvoiceReview: vi.fn(),
  submitInvoiceReview: vi.fn(),
  retryDeadLetter: vi.fn(),
  invoiceSourceUrl: (id: string) => `/api/invoices/${id}/source`,
  invoiceDocumentUrl: (id: string) => `/api/invoices/${id}/document`,
}));

const {
  getInvoiceStatus,
  getInvoiceReview,
  retryDeadLetter,
  submitInvoiceReview,
} = await import('@/lib/api/client');

const emptyParty: Party = {
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

function extractedDataOf(
  overrides: Partial<RawExtractedInvoiceData> = {},
): RawExtractedInvoiceData {
  return {
    invoiceNumber: '2026-0412',
    issueDate: '2026-04-12',
    dueDate: null,
    deliveryDate: null,
    currency: 'EUR',
    seller: { ...emptyParty, countryCode: 'DE' },
    buyer: { ...emptyParty, countryCode: 'DE' },
    sellerIban: null,
    sellerBic: null,
    lineItems: [],
    netTotal: '1190.00',
    vatBreakdown: [],
    vatTotal: '226.10',
    grossTotal: '1416.10',
    paymentTerms: 'ORIGINAL-FROM-SERVER',
    buyerReference: null,
    ...overrides,
  };
}

function statusOf(
  overrides: Partial<InvoiceStatusResult> = {},
): InvoiceStatusResult {
  return {
    id: 'inv-1',
    status: 'NEEDS_REVIEW',
    sourceType: 'NATIVE',
    pageCount: 1,
    failure: null,
    ...overrides,
  };
}

function detailOf(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1',
    originalFilename: 'invoice.pdf',
    status: 'NEEDS_REVIEW',
    sourceType: 'NATIVE',
    pageCount: 1,
    failure: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reviewedAt: null,
    extractedData: extractedDataOf(),
    lifecycleToken: 'a'.repeat(64),
    findings: [],
    deadLetter: null,
    ...overrides,
  };
}

function renderWorkspace(invoiceId = 'inv-1') {
  return render(
    <DictionaryProvider locale="de">
      <ReviewWorkspace invoiceId={invoiceId} />
    </DictionaryProvider>,
  );
}

describe('ReviewWorkspace submission boundaries', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(submitInvoiceReview).mockReset();
  });

  it('shows an initial load error and recovers when retry succeeds', async () => {
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({ ok: true, data: statusOf() })
      .mockResolvedValueOnce({ ok: true, data: statusOf() });
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network_error' } })
      .mockResolvedValueOnce({ ok: true, data: detailOf() });

    renderWorkspace();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Keine Verbindung zum Server.',
    );
    expect(screen.queryByText('Wird geladen…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    expect(await screen.findByLabelText('Zahlungsbedingungen')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let an older retry overwrite a newer reload', async () => {
    let resolveOlderStatus: (value: {
      ok: true;
      data: InvoiceStatusResult;
    }) => void = () => {};
    let resolveOlderDetail: (value: {
      ok: true;
      data: InvoiceDetail;
    }) => void = () => {};
    let resolveNewerStatus: (value: {
      ok: true;
      data: InvoiceStatusResult;
    }) => void = () => {};
    let resolveNewerDetail: (value: {
      ok: true;
      data: InvoiceDetail;
    }) => void = () => {};
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({ ok: true, data: statusOf() })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderStatus = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNewerStatus = resolve;
        }),
      );
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network_error' } })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderDetail = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNewerDetail = resolve;
        }),
      );

    renderWorkspace();
    await screen.findByRole('alert');

    const retry = screen.getByRole('button', { name: 'Erneut versuchen' });
    fireEvent.click(retry);
    fireEvent.click(retry);

    resolveNewerStatus({ ok: true, data: statusOf() });
    resolveNewerDetail({
      ok: true,
      data: detailOf({
        extractedData: extractedDataOf({ paymentTerms: 'NEWER' }),
      }),
    });

    const paymentTerms = await screen.findByLabelText('Zahlungsbedingungen');
    expect((paymentTerms as HTMLInputElement).value).toBe('NEWER');

    await act(async () => {
      resolveOlderStatus({ ok: true, data: statusOf() });
      resolveOlderDetail({
        ok: true,
        data: detailOf({
          extractedData: extractedDataOf({ paymentTerms: 'OLDER' }),
        }),
      });
      await Promise.resolve();
    });

    expect((paymentTerms as HTMLInputElement).value).toBe('NEWER');
  });

  it('binds a wire-schema error to the indexed input without posting', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf(),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({
        extractedData: extractedDataOf({
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
        }),
      }),
    });

    renderWorkspace();

    const description = await screen.findByLabelText('Bezeichnung');
    fireEvent.change(description, { target: { value: '\u0007' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Prüfen und absenden' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Absenden' }));

    expect(vi.mocked(submitInvoiceReview)).not.toHaveBeenCalled();
    await screen.findByRole('alert');
    expect(
      screen.getByLabelText('Bezeichnung').getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('keeps the form disabled when an accepted correction returns no capability', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf(),
    });
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({ ok: true, data: detailOf() })
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network_error' } });
    vi.mocked(submitInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: { status: 'GENERATING', lifecycleToken: null },
    });

    renderWorkspace();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Prüfen und absenden' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      const submit = screen.getByRole('button', {
        name: 'Prüfen und absenden',
      });
      expect(submit.hasAttribute('disabled')).toBe(true);
    });
  });
});

describe('ReviewWorkspace poll-triggered detail refresh', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an unsaved edit when a poll refetches different data', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ status: 'GENERATING' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({ status: 'GENERATING' }),
    });

    renderWorkspace();

    const input = await screen.findByLabelText('Zahlungsbedingungen');
    expect((input as HTMLInputElement).value).toBe('ORIGINAL-FROM-SERVER');

    fireEvent.change(input, { target: { value: 'EDITED-BY-USER' } });
    expect((input as HTMLInputElement).value).toBe('EDITED-BY-USER');

    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ status: 'NEEDS_REVIEW' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({
        status: 'NEEDS_REVIEW',
        extractedData: extractedDataOf({ paymentTerms: 'SERVER-VALUE' }),
      }),
    });

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() =>
      expect(vi.mocked(getInvoiceReview)).toHaveBeenCalledTimes(2),
    );

    expect((input as HTMLInputElement).value).toBe('EDITED-BY-USER');
  });

  it('still applies the server refresh when there is no unsaved edit', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ status: 'GENERATING' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({ status: 'GENERATING' }),
    });

    renderWorkspace();

    const input = await screen.findByLabelText('Zahlungsbedingungen');
    expect((input as HTMLInputElement).value).toBe('ORIGINAL-FROM-SERVER');

    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ status: 'NEEDS_REVIEW' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({
        status: 'NEEDS_REVIEW',
        extractedData: extractedDataOf({ paymentTerms: 'SERVER-VALUE' }),
      }),
    });

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() =>
      expect((input as HTMLInputElement).value).toBe('SERVER-VALUE'),
    );
  });
});

describe('ReviewWorkspace invoice changes', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(submitInvoiceReview).mockReset();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores a previous invoice status response after the route changes', async () => {
    let resolveStaleStatus: (value: ReturnType<typeof statusOf>) => void = () =>
      undefined;
    const staleStatus = new Promise<ReturnType<typeof statusOf>>((resolve) => {
      resolveStaleStatus = resolve;
    });
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({
        ok: true,
        data: statusOf({ status: 'GENERATING' }),
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        data: await staleStatus,
      }))
      .mockResolvedValueOnce({
        ok: true,
        data: statusOf({ id: 'inv-2', status: 'NEEDS_REVIEW' }),
      });
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({ status: 'GENERATING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({ id: 'inv-2', originalFilename: 'invoice-2.pdf' }),
      });

    const rendered = renderWorkspace();
    await screen.findByLabelText('Zahlungsbedingungen');

    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.mocked(getInvoiceStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getInvoiceStatus)).toHaveBeenLastCalledWith('inv-1');
    rendered.rerender(
      <DictionaryProvider locale="de">
        <ReviewWorkspace invoiceId="inv-2" />
      </DictionaryProvider>,
    );
    await waitFor(() =>
      expect(vi.mocked(getInvoiceReview)).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveStaleStatus(statusOf({ status: 'READY' }));
      await Promise.resolve();
    });
    expect(
      screen.queryByRole('link', { name: 'XRechnung herunterladen' }),
    ).toBeNull();
  });

  it('ignores a previous invoice detail response after the route changes', async () => {
    let inv1StatusCalls = 0;
    let inv1ReviewCalls = 0;
    let resolveStaleDetail: (value: {
      ok: false;
      error: { kind: 'not_found' };
    }) => void = () => undefined;
    const staleDetail = new Promise<{
      ok: false;
      error: { kind: 'not_found' };
    }>((resolve) => {
      resolveStaleDetail = resolve;
    });

    vi.mocked(getInvoiceStatus).mockImplementation((id) => {
      if (id === 'inv-2') {
        return Promise.resolve({
          ok: true,
          data: statusOf({ id, status: 'NEEDS_REVIEW' }),
        });
      }
      inv1StatusCalls += 1;
      return Promise.resolve({
        ok: true,
        data: statusOf({
          status:
            inv1StatusCalls === 1
              ? 'GENERATING'
              : inv1StatusCalls === 2
                ? 'NEEDS_REVIEW'
                : 'GENERATING',
        }),
      });
    });
    vi.mocked(getInvoiceReview).mockImplementation((id) => {
      if (id === 'inv-2') {
        return Promise.resolve({
          ok: true,
          data: detailOf({ id, originalFilename: 'invoice-2.pdf' }),
        });
      }
      inv1ReviewCalls += 1;
      if (inv1ReviewCalls === 1) {
        return Promise.resolve({
          ok: true,
          data: detailOf({ status: 'GENERATING' }),
        });
      }
      return staleDetail;
    });

    const rendered = renderWorkspace();
    await screen.findByLabelText('Zahlungsbedingungen');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() =>
      expect(vi.mocked(getInvoiceReview)).toHaveBeenCalledTimes(2),
    );

    rendered.rerender(
      <DictionaryProvider locale="de">
        <ReviewWorkspace invoiceId="inv-2" />
      </DictionaryProvider>,
    );
    await waitFor(() =>
      expect(vi.mocked(getInvoiceReview)).toHaveBeenCalledWith('inv-2'),
    );

    await act(async () => {
      resolveStaleDetail({ ok: false, error: { kind: 'not_found' } });
      await Promise.resolve();
    });
    expect(
      screen.queryByText('Diese Rechnung ist nicht mehr verfügbar.'),
    ).toBeNull();
  });

  it('ignores a previous invoice submit completion after the route changes', async () => {
    let resolveStaleSubmission: (value: {
      ok: true;
      data: { status: 'GENERATING'; lifecycleToken: null };
    }) => void = () => undefined;
    const staleSubmission = new Promise<{
      ok: true;
      data: { status: 'GENERATING'; lifecycleToken: null };
    }>((resolve) => {
      resolveStaleSubmission = resolve;
    });
    vi.mocked(getInvoiceStatus).mockImplementation((id) =>
      Promise.resolve({
        ok: true,
        data: statusOf({ id, status: 'NEEDS_REVIEW' }),
      }),
    );
    vi.mocked(getInvoiceReview).mockImplementation((id) =>
      Promise.resolve({
        ok: true,
        data: detailOf({ id, originalFilename: `${id}.pdf` }),
      }),
    );
    vi.mocked(submitInvoiceReview).mockImplementationOnce(
      () => staleSubmission,
    );

    const rendered = renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Prüfen und absenden' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Absenden' }));
    await waitFor(() =>
      expect(vi.mocked(submitInvoiceReview)).toHaveBeenCalledTimes(1),
    );

    rendered.rerender(
      <DictionaryProvider locale="de">
        <ReviewWorkspace invoiceId="inv-2" />
      </DictionaryProvider>,
    );
    await waitFor(() =>
      expect(vi.mocked(getInvoiceReview)).toHaveBeenCalledWith('inv-2'),
    );

    await act(async () => {
      resolveStaleSubmission({
        ok: true,
        data: { status: 'GENERATING', lifecycleToken: null },
      });
      await Promise.resolve();
    });
    expect(
      screen.queryByText(
        'Korrektur übernommen — die XRechnung wird jetzt erzeugt.',
      ),
    ).toBeNull();
  });
});

describe('ReviewWorkspace dead-letter retry poll override', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(retryDeadLetter).mockReset();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling when a retry never produces a transition', async () => {
    const failedStatus = statusOf({
      status: 'FAILED',
      failure: { code: 'validation_retries_exhausted' },
    });
    vi.mocked(getInvoiceStatus).mockResolvedValue({
      ok: true,
      data: failedStatus,
    });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: true,
      data: detailOf({
        status: 'FAILED',
        failure: { code: 'validation_retries_exhausted' },
        lifecycleToken: null,
        deadLetter: { stage: 'validation', failedAt: '2026-08-15T00:00:00Z' },
      }),
    });
    vi.mocked(retryDeadLetter).mockResolvedValue({ ok: true, data: undefined });

    renderWorkspace();

    const retryButton = await screen.findByRole('button', {
      name: 'Erneut versuchen',
    });
    fireEvent.click(retryButton);

    await waitFor(() => expect(retryDeadLetter).toHaveBeenCalledTimes(1));
    const statusCallsAfterRetry = vi.mocked(getInvoiceStatus).mock.calls.length;

    for (let tick = 0; tick < 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    await screen.findByText(
      'Der erneute Versuch hat den Status nicht verändert. Bitte die Seite neu laden oder es später erneut versuchen.',
    );

    const statusCallsAtGiveUp = vi.mocked(getInvoiceStatus).mock.calls.length;
    expect(statusCallsAtGiveUp).toBeGreaterThan(statusCallsAfterRetry);

    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.mocked(getInvoiceStatus).mock.calls.length).toBe(
      statusCallsAtGiveUp,
    );
  });
});

describe('ReviewWorkspace line-item restructuring', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
  });

  function lineItemOf(overrides: Partial<LineItem> = {}): LineItem {
    return {
      position: 1,
      description: 'Beratung',
      quantity: '2',
      unit: 'HUR',
      unitPrice: '595.00',
      netAmount: '1190.00',
      vatRate: '19',
      vatExemptionReason: null,
      ...overrides,
    };
  }

  function findingOf(overrides: Partial<InvoiceFinding> = {}): InvoiceFinding {
    return {
      rule: 'test.marker_rule',
      field: 'lineItems[1].netAmount',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: row 2 net amount finding',
      expected: '1190.00',
      actual: '1200.00',
      ...overrides,
    };
  }

  it('keeps restructured collection findings as evidence but removes them from actionable UI', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ status: 'NEEDS_REVIEW' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({
        extractedData: extractedDataOf({
          lineItems: [
            lineItemOf({ position: 1, description: 'Row A' }),
            lineItemOf({ position: 2, description: 'Row B' }),
          ],
          vatBreakdown: [
            {
              rate: '19',
              base: '1190.00',
              amount: '226.10',
              category: null,
              exemptionReason: null,
            },
          ],
        }),
        findings: [
          findingOf(),
          findingOf({
            field: 'vatBreakdown[0].amount',
            message: 'MARKER: VAT amount finding',
          }),
        ],
      }),
    });

    const { container } = renderWorkspace();
    function formText(): string {
      const form = container.querySelector('form');
      return form?.textContent ?? '';
    }

    await screen.findByRole('button', { name: 'Position 1 entfernen' });
    expect(formText()).toContain('MARKER: row 2 net amount finding');
    expect(formText()).toContain('MARKER: VAT amount finding');

    fireEvent.click(
      screen.getByRole('button', { name: 'Position 1 entfernen' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Steuersatzgruppe 1 entfernen' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Position hinzufügen' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Steuersatzgruppe hinzufügen' }),
    );

    expect(formText()).not.toContain('MARKER: row 2 net amount finding');
    expect(formText()).not.toContain('MARKER: VAT amount finding');
    expect(
      container.querySelector('a[href="#field-lineItems-1--netAmount"]'),
    ).toBeNull();
    expect(
      container.querySelector('a[href="#field-vatBreakdown-0--amount"]'),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Prüfen und absenden' }),
    );
    const confirmation = await screen.findByRole('heading', {
      name: 'Prüfen und absenden',
    });
    expect(confirmation.parentElement?.textContent).not.toContain(
      'MARKER: row 2 net amount finding',
    );
    expect(confirmation.parentElement?.textContent).not.toContain(
      'MARKER: VAT amount finding',
    );
    expect(container.textContent).toContain('MARKER: row 2 net amount finding');
    expect(container.textContent).toContain('MARKER: VAT amount finding');
  });
});

describe('ReviewWorkspace OCR notice', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
  });

  it('warns the reviewer when the document was read with OCR', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValueOnce({
      ok: true,
      data: statusOf({ sourceType: 'OCR' }),
    });
    vi.mocked(getInvoiceReview).mockResolvedValueOnce({
      ok: true,
      data: detailOf({ sourceType: 'OCR' }),
    });

    renderWorkspace();

    expect(
      await screen.findByText(
        'Dieser Beleg wurde per Texterkennung gelesen. Prüfen Sie alle Angaben besonders sorgfältig gegen das Original.',
      ),
    ).toBeTruthy();
  });
});

describe('ReviewWorkspace lifecycle ownership', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(retryDeadLetter).mockReset();
    vi.mocked(submitInvoiceReview).mockReset();
  });

  it('shows fresh indexed findings after submitting a restructured collection', async () => {
    const lineItem = {
      position: 1,
      description: 'Beratung',
      quantity: '2',
      unit: 'HUR',
      unitPrice: '595.00',
      netAmount: '1190.00',
      vatRate: '19',
      vatExemptionReason: null,
    } satisfies LineItem;
    const freshFinding = {
      rule: 'test.fresh_server_finding',
      field: 'lineItems[0].description',
      severity: 'ERROR',
      passed: false,
      message: 'FRESH SERVER FINDING',
      expected: 'present',
      actual: null,
    } satisfies InvoiceFinding;
    vi.mocked(getInvoiceStatus).mockResolvedValue({
      ok: true,
      data: statusOf(),
    });
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({
          extractedData: extractedDataOf({ lineItems: [lineItem] }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({
          lifecycleToken: 'b'.repeat(64),
          extractedData: extractedDataOf({
            lineItems: [{ ...lineItem, description: null }],
          }),
          findings: [freshFinding],
        }),
      });
    vi.mocked(submitInvoiceReview).mockResolvedValue({
      ok: true,
      data: { status: 'NEEDS_REVIEW', lifecycleToken: 'b'.repeat(64) },
    });

    const { container } = renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Position 1 entfernen' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Position hinzufügen' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Prüfen und absenden' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Absenden' }));

    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('form')).not.toBeNull());
    expect(container.querySelector('form')?.textContent).toContain(
      'FRESH SERVER FINDING',
    );
  });

  it('rebuilds the entire draft from the server after a conflict', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValue({
      ok: true,
      data: statusOf(),
    });
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({
          extractedData: extractedDataOf({
            paymentTerms: 'SERVER-A',
            buyerReference: 'REMOTE-A',
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({
          lifecycleToken: 'b'.repeat(64),
          extractedData: extractedDataOf({
            paymentTerms: 'SERVER-B',
            buyerReference: 'REMOTE-B',
          }),
        }),
      });
    vi.mocked(submitInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'conflict' },
    });

    renderWorkspace();
    fireEvent.change(await screen.findByLabelText('Zahlungsbedingungen'), {
      target: { value: 'LOCAL' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Prüfen und absenden' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Absenden' }));

    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledTimes(2));
    expect(
      screen.getByLabelText<HTMLInputElement>('Zahlungsbedingungen').value,
    ).toBe('SERVER-B');
    expect(screen.getByLabelText<HTMLInputElement>('Leitweg-ID').value).toBe(
      'REMOTE-B',
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Der Status hat sich geändert',
    );
  });

  it('ignores a dead-letter retry completion after the invoice changes', async () => {
    let resolveRetry: (value: { ok: true; data: undefined }) => void = () => {};
    vi.mocked(retryDeadLetter).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    vi.mocked(getInvoiceStatus).mockImplementation((id) =>
      Promise.resolve({
        ok: true,
        data: statusOf({
          id,
          status: id === 'inv-1' ? 'FAILED' : 'NEEDS_REVIEW',
          failure:
            id === 'inv-1' ? { code: 'validation_retries_exhausted' } : null,
        }),
      }),
    );
    vi.mocked(getInvoiceReview).mockImplementation((id) =>
      Promise.resolve({
        ok: true,
        data: detailOf({
          id,
          originalFilename: `${id}.pdf`,
          status: id === 'inv-1' ? 'FAILED' : 'NEEDS_REVIEW',
          failure:
            id === 'inv-1' ? { code: 'validation_retries_exhausted' } : null,
          lifecycleToken: id === 'inv-1' ? null : 'b'.repeat(64),
          deadLetter:
            id === 'inv-1'
              ? { stage: 'validation', failedAt: '2026-08-15T00:00:00Z' }
              : null,
        }),
      }),
    );

    const rendered = renderWorkspace('inv-1');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Erneut versuchen' }),
    );
    await waitFor(() => expect(retryDeadLetter).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <DictionaryProvider locale="de">
        <ReviewWorkspace invoiceId="inv-2" />
      </DictionaryProvider>,
    );
    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledWith('inv-2'));

    await act(async () => {
      resolveRetry({ ok: true, data: undefined });
      await Promise.resolve();
    });

    expect(
      vi.mocked(getInvoiceStatus).mock.calls.filter(([id]) => id === 'inv-1'),
    ).toHaveLength(1);
    expect(
      vi.mocked(getInvoiceReview).mock.calls.filter(([id]) => id === 'inv-1'),
    ).toHaveLength(1);
  });

  it('ignores an older detail response after retry observes a newer status', async () => {
    let resolveNextStatus: (value: {
      ok: true;
      data: InvoiceStatusResult;
    }) => void = () => {};
    let resolveOlderDetail: (value: {
      ok: true;
      data: InvoiceDetail;
    }) => void = () => {};
    const failedStatus = statusOf({
      status: 'FAILED',
      failure: { code: 'validation_retries_exhausted' },
    });
    const failedDetail = detailOf({
      status: 'FAILED',
      failure: { code: 'validation_retries_exhausted' },
      lifecycleToken: null,
      deadLetter: { stage: 'validation', failedAt: '2026-08-15T00:00:00Z' },
    });
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({ ok: true, data: failedStatus })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNextStatus = resolve;
        }),
      );
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({ ok: true, data: failedDetail })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderDetail = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: detailOf({ lifecycleToken: 'b'.repeat(64) }),
      });
    vi.mocked(retryDeadLetter).mockResolvedValueOnce({
      ok: true,
      data: undefined,
    });

    renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Erneut versuchen' }),
    );
    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNextStatus({ ok: true, data: statusOf() });
      await Promise.resolve();
    });
    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: 'Prüfen und absenden',
        }).disabled,
      ).toBe(false),
    );

    await act(async () => {
      resolveOlderDetail({ ok: true, data: failedDetail });
      await Promise.resolve();
    });

    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Prüfen und absenden',
      }).disabled,
    ).toBe(false);
  });
});
