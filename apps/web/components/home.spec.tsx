import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { POLL_INTERVAL_MS } from '@/lib/polling/use-polling';
import { Home } from './home';
import type { InvoiceListItem, UploadAcceptedResult } from '@/lib/api/schemas';

vi.mock('@/lib/api/home-client', () => ({
  uploadInvoice: vi.fn(),
  listInvoices: vi.fn(),
  deleteInvoice: vi.fn(),
  invoiceDocumentUrl: (id: string) => `/api/invoices/${id}/document`,
}));

const { uploadInvoice, listInvoices, deleteInvoice } =
  await import('@/lib/api/home-client');

function pdfFile(name = 'invoice.pdf') {
  return new File([new Uint8Array(10)], name, { type: 'application/pdf' });
}

function renderHome() {
  return render(
    <DictionaryProvider locale="de">
      <Home />
    </DictionaryProvider>,
  );
}

describe('Home upload', () => {
  beforeEach(() => {
    vi.mocked(uploadInvoice).mockReset();
    vi.mocked(listInvoices).mockReset();
    vi.mocked(deleteInvoice).mockReset();
    vi.mocked(listInvoices).mockResolvedValue({ ok: true, data: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the uploaded row immediately, before any list refetch resolves', async () => {
    const result: UploadAcceptedResult = {
      id: 'inv-1',
      status: 'UPLOADED',
      deduplicated: false,
    };
    let resolveUpload: (value: {
      ok: true;
      data: UploadAcceptedResult;
    }) => void = () => {};
    vi.mocked(uploadInvoice).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    vi.mocked(listInvoices).mockReturnValue(new Promise(() => {}));

    renderHome();
    const input = screen.getByLabelText(
      'PDF hierher ziehen oder Datei auswählen',
    );
    fireEvent.change(input, { target: { files: [pdfFile('rechnung.pdf')] } });

    resolveUpload({ ok: true, data: result });

    expect(await screen.findByText('rechnung.pdf')).toBeTruthy();
  });

  it('shows loading instead of the empty state until the first list request settles', async () => {
    let resolveList: (value: {
      ok: true;
      data: InvoiceListItem[];
    }) => void = () => {};
    vi.mocked(listInvoices).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    renderHome();

    expect(screen.getByText('Wird geladen …')).toBeTruthy();
    expect(
      screen.queryByText('Aus einer PDF-Rechnung eine XRechnung machen'),
    ).toBeNull();

    resolveList({ ok: true, data: [] });
    expect(
      await screen.findByText('Aus einer PDF-Rechnung eine XRechnung machen'),
    ).toBeTruthy();
  });

  it('shows a retryable error instead of an empty state when the initial list fails', async () => {
    vi.mocked(listInvoices)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network_error' } })
      .mockResolvedValueOnce({ ok: true, data: [] });

    renderHome();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Keine Verbindung zum Server.',
    );
    expect(screen.queryByText('Noch keine Rechnungen')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      screen.getByText('Aus einer PDF-Rechnung eine XRechnung machen'),
    ).toBeTruthy();
  });

  it('does not let a stale in-flight poll response erase a just-uploaded row', async () => {
    const result: UploadAcceptedResult = {
      id: 'inv-1',
      status: 'UPLOADED',
      deduplicated: false,
    };
    let resolveStalePoll: (value: { ok: true; data: [] }) => void = () => {};
    vi.mocked(listInvoices).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStalePoll = resolve;
      }),
    );
    vi.mocked(listInvoices).mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: 'inv-1',
          originalFilename: 'rechnung.pdf',
          status: 'UPLOADED',
          createdAt: '2026-08-26T00:00:00.000Z',
          expiresAt: '2026-08-26T02:00:00.000Z',
          failure: null,
        },
      ],
    });
    vi.mocked(uploadInvoice).mockResolvedValueOnce({ ok: true, data: result });

    renderHome();
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(1));

    const input = screen.getByLabelText(
      'PDF hierher ziehen oder Datei auswählen',
    );
    fireEvent.change(input, { target: { files: [pdfFile('rechnung.pdf')] } });

    await screen.findByText('rechnung.pdf');
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2));

    resolveStalePoll({ ok: true, data: [] });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('rechnung.pdf')).toBeTruthy();
  });

  it('does not let a stale in-flight poll response resurrect a just-deleted row', async () => {
    const failedRow = {
      id: 'inv-1',
      originalFilename: 'invoice.pdf',
      status: 'FAILED' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T02:00:00.000Z',
      failure: { code: 'llm_provider_error' as const },
    };
    const activeRow = {
      id: 'inv-2',
      originalFilename: 'other.pdf',
      status: 'EXTRACTING_TEXT' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T02:00:00.000Z',
      failure: null,
    };
    let resolveStalePoll: (value: {
      ok: true;
      data: InvoiceListItem[];
    }) => void = () => {};
    vi.mocked(listInvoices)
      .mockResolvedValueOnce({ ok: true, data: [failedRow, activeRow] })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStalePoll = resolve;
        }),
      )
      .mockReturnValue(new Promise(() => {}));
    vi.mocked(deleteInvoice).mockResolvedValueOnce({
      ok: true,
      data: undefined,
    });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderHome();
      await screen.findByText('invoice.pdf');

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole('button', { name: 'Rechnung löschen' }));
      fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));

      await vi.waitFor(() =>
        expect(deleteInvoice).toHaveBeenCalledWith('inv-1'),
      );

      resolveStalePoll({ ok: true, data: [failedRow, activeRow] });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText('invoice.pdf')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a slow poll response instead of discarding it at the next interval', async () => {
    const activeRow = {
      id: 'inv-1',
      originalFilename: 'invoice.pdf',
      status: 'EXTRACTING_TEXT' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T02:00:00.000Z',
      failure: null,
    };
    let resolveSlowPoll: (value: {
      ok: true;
      data: InvoiceListItem[];
    }) => void = () => {};
    vi.mocked(listInvoices)
      .mockResolvedValueOnce({ ok: true, data: [activeRow] })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlowPoll = resolve;
        }),
      )
      .mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderHome();
      await screen.findByText('invoice.pdf');

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      resolveSlowPoll({
        ok: true,
        data: [
          activeRow,
          { ...activeRow, id: 'inv-2', originalFilename: 'second.pdf' },
        ],
      });

      expect(await screen.findByText('second.pdf')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate the row when the real list already carries the uploaded id', async () => {
    const realRow = {
      id: 'inv-1',
      originalFilename: 'invoice.pdf',
      status: 'EXTRACTING_TEXT' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T02:00:00.000Z',
      failure: null,
    };
    vi.mocked(listInvoices)
      .mockResolvedValueOnce({ ok: true, data: [realRow] })
      .mockReturnValue(new Promise(() => {}));
    vi.mocked(uploadInvoice).mockResolvedValueOnce({
      ok: true,
      data: { id: 'inv-1', status: 'UPLOADED', deduplicated: false },
    });

    renderHome();
    await screen.findByText('invoice.pdf');

    const input = screen.getByLabelText(
      'PDF hierher ziehen oder Datei auswählen',
    );
    fireEvent.change(input, { target: { files: [pdfFile('invoice.pdf')] } });

    await vi.waitFor(() => expect(uploadInvoice).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getAllByText('invoice.pdf')).toHaveLength(1);
  });

  it('does not insert a synthetic row for a deduplicated upload', async () => {
    vi.mocked(uploadInvoice).mockResolvedValueOnce({
      ok: true,
      data: { id: 'inv-existing', status: 'READY', deduplicated: true },
    });
    vi.mocked(listInvoices).mockReturnValue(new Promise(() => {}));

    renderHome();
    const input = screen.getByLabelText(
      'PDF hierher ziehen oder Datei auswählen',
    );
    fireEvent.change(input, { target: { files: [pdfFile('rechnung.pdf')] } });

    await screen.findByText('Diese Datei liegt bereits in der Liste.');
    expect(screen.queryByText('rechnung.pdf')).toBeNull();
  });

  it('names the row a duplicate landed on, not the file that was dropped', async () => {
    const existingRow = {
      id: 'inv-existing',
      originalFilename: 'zuerst-hochgeladen.pdf',
      status: 'NEEDS_REVIEW' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T02:00:00.000Z',
      failure: null,
    };
    vi.mocked(listInvoices).mockResolvedValue({
      ok: true,
      data: [existingRow],
    });
    vi.mocked(uploadInvoice).mockResolvedValueOnce({
      ok: true,
      data: { id: 'inv-existing', status: 'NEEDS_REVIEW', deduplicated: true },
    });

    renderHome();
    await screen.findByText('zuerst-hochgeladen.pdf');
    const input = screen.getByLabelText(
      'PDF hierher ziehen oder Datei auswählen',
    );
    fireEvent.change(input, { target: { files: [pdfFile('rechnung.pdf')] } });

    await screen.findByText(/„zuerst-hochgeladen\.pdf“/);
    expect(screen.queryByText('rechnung.pdf')).toBeNull();
  });
});
