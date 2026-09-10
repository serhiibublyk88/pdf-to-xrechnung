import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { InvoiceList } from './invoice-list';
import type {
  InvoiceFailure,
  InvoiceListItem,
  InvoiceStatus,
} from '@/lib/api/schemas';

vi.mock('@/lib/api/home-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/home-client')>(
    '@/lib/api/home-client',
  );
  return { ...actual, deleteInvoice: vi.fn() };
});

const { deleteInvoice } = await import('@/lib/api/home-client');

function row(
  status: InvoiceStatus,
  failure: InvoiceFailure | null = null,
): InvoiceListItem {
  return {
    id: 'e6b0f0e2-6c1a-4a1e-9f9a-2f5b6c7d8e90',
    originalFilename: 'invoice.pdf',
    status,
    createdAt: '2026-08-27T10:00:00.000Z',
    expiresAt: '2026-08-27T12:00:00.000Z',
    failure,
  };
}

function renderList(
  invoices: InvoiceListItem[],
  onDeleted: (id: string) => void = vi.fn(),
) {
  render(
    <DictionaryProvider locale="de">
      <InvoiceList
        invoices={invoices}
        highlightId={null}
        onDeleted={onDeleted}
      />
    </DictionaryProvider>,
  );
}

function openDeleteDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Rechnung löschen' }));
}

describe('InvoiceList stage attribution', () => {
  it('names the stage the failure code points at, not the first one', () => {
    renderList([row('FAILED', { code: 'llm_provider_error' })]);

    expect(screen.getByText(/Datenextraktion/)).toBeTruthy();
    expect(screen.queryByText(/Textextraktion/)).toBeNull();
    expect(screen.getByText(/Schritt 3 von 5/)).toBeTruthy();
  });

  it('names the text stage for a text-extraction failure', () => {
    renderList([row('FAILED', { code: 'pdf_unreadable' })]);

    expect(screen.getByText(/Textextraktion/)).toBeTruthy();
    expect(screen.getByText(/Schritt 2 von 5/)).toBeTruthy();
  });
});

describe('InvoiceList deletion', () => {
  it('offers deletion only for a resting lifecycle', () => {
    renderList([row('EXTRACTING_DATA')]);

    expect(
      screen.queryByRole('button', { name: 'Rechnung löschen' }),
    ).toBeNull();
  });

  it('names the file in the confirmation before anything is sent', () => {
    renderList([row('FAILED', { code: 'llm_provider_error' })]);

    openDeleteDialog();

    expect(screen.getByText(/„invoice\.pdf“/)).toBeTruthy();
    expect(vi.mocked(deleteInvoice)).not.toHaveBeenCalled();
  });

  it('keeps the invoice when the confirmation is dismissed', () => {
    renderList([row('READY')]);

    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    expect(vi.mocked(deleteInvoice)).not.toHaveBeenCalled();
  });

  it('reports the deleted id upward once the server confirms', async () => {
    const onDeleted = vi.fn();
    vi.mocked(deleteInvoice).mockResolvedValueOnce({
      ok: true,
      data: undefined,
    });
    renderList([row('FAILED', { code: 'llm_provider_error' })], onDeleted);

    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));

    await waitFor(() =>
      expect(onDeleted).toHaveBeenCalledWith(
        'e6b0f0e2-6c1a-4a1e-9f9a-2f5b6c7d8e90',
      ),
    );
    expect(screen.queryByText('Rechnung löschen?')).toBeNull();
    expect(vi.mocked(deleteInvoice)).toHaveBeenCalledWith(
      'e6b0f0e2-6c1a-4a1e-9f9a-2f5b6c7d8e90',
    );
  });

  it('keeps the row and explains a conflict as a status change, not a generic failure', async () => {
    const onDeleted = vi.fn();
    vi.mocked(deleteInvoice).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'conflict' },
    });
    renderList([row('FAILED', { code: 'llm_provider_error' })], onDeleted);

    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));

    expect(
      await screen.findByText(
        'Der Status hat sich geändert — die Ansicht wird aktualisiert.',
      ),
    ).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('shows a distinct message with a retry time for a rate-limited delete', async () => {
    const onDeleted = vi.fn();
    vi.mocked(deleteInvoice).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'rate_limited', retryAfterSeconds: 30 },
    });
    renderList([row('FAILED', { code: 'llm_provider_error' })], onDeleted);

    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));

    expect(
      await screen.findByText(/Bitte in 30 Sekunden erneut versuchen/),
    ).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
