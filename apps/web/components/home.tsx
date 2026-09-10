'use client';

import { useEffect, useRef, useState } from 'react';
import { listInvoices } from '@/lib/api/home-client';
import { describeApiError } from '@/lib/api/error-message';
import type { ApiError } from '@/lib/api/errors';
import { useDictionary } from '@/lib/i18n/dictionary-context';
import { POLL_INTERVAL_MS, usePolling } from '@/lib/polling/use-polling';
import { hasNonTerminal } from '@/lib/review/grouping';
import type {
  InvoiceListItem,
  UploadAcceptedResult,
} from '@/lib/api/base-schemas';
import { UploadDropzone } from './upload-dropzone';
import { InvoiceList } from './invoice-list';

const APPROXIMATE_RETENTION_HOURS = 2;

export function Home() {
  const dictionary = useDictionary();
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [duplicateOfId, setDuplicateOfId] = useState<string | null>(null);
  const invoicesRef = useRef<InvoiceListItem[]>(invoices);
  useEffect(() => {
    invoicesRef.current = invoices;
  }, [invoices]);

  const duplicateRow = invoices.find((invoice) => invoice.id === duplicateOfId);
  const invoicesSeqRef = useRef(0);

  const isMounted = usePolling(fetchOnce, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: () => hasNonTerminal(invoicesRef.current),
    runImmediately: true,
  });

  async function fetchOnce() {
    const seq = ++invoicesSeqRef.current;
    const listed = await listInvoices();
    if (!isMounted() || seq !== invoicesSeqRef.current) return;
    if (listed.ok) {
      setInvoices(listed.data);
      setLoadError(null);
    } else setLoadError(listed.error);
    setHasLoaded(true);
  }

  function handleUploaded(result: UploadAcceptedResult, filename: string) {
    setDuplicateOfId(result.deduplicated ? result.id : null);
    if (!result.deduplicated) {
      const now = new Date();
      invoicesSeqRef.current += 1;
      setInvoices((current) =>
        current.some((invoice) => invoice.id === result.id)
          ? current
          : [
              {
                id: result.id,
                originalFilename: filename,
                status: result.status,
                createdAt: now.toISOString(),
                expiresAt: new Date(
                  now.getTime() + APPROXIMATE_RETENTION_HOURS * 60 * 60 * 1000,
                ).toISOString(),
                failure: null,
              },
              ...current,
            ],
      );
    }
    void fetchOnce();
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-4 text-xl font-semibold">{dictionary.upload.title}</h1>
      <UploadDropzone onUploaded={handleUploaded} />
      {duplicateOfId && (
        <p
          role="status"
          className="mt-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-text-muted"
        >
          {duplicateRow
            ? dictionary.upload.deduplicatedNotice(
                duplicateRow.originalFilename,
              )
            : dictionary.upload.deduplicatedNoticeUnnamed}
        </p>
      )}
      <h2 className="mt-8 mb-3 text-lg font-semibold">
        {dictionary.upload.listTitle}
      </h2>
      {loadError && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          <span>{describeApiError(loadError, dictionary)}</span>
          <button
            type="button"
            onClick={() => void fetchOnce()}
            className="rounded-md border border-current px-3 py-1.5 font-medium hover:opacity-80"
          >
            {dictionary.common.retry}
          </button>
        </div>
      )}
      {invoices.length === 0 && !hasLoaded ? (
        <p role="status" className="text-sm text-text-muted">
          {dictionary.common.loading}
        </p>
      ) : invoices.length > 0 || loadError === null ? (
        <InvoiceList
          invoices={invoices}
          highlightId={duplicateOfId}
          onDeleted={(id) => {
            invoicesSeqRef.current += 1;
            setInvoices((current) =>
              current.filter((invoice) => invoice.id !== id),
            );
          }}
        />
      ) : null}
    </div>
  );
}
