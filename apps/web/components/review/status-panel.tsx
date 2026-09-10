'use client';

import { useState } from 'react';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import { describeApiError } from '@/lib/api/error-message';
import { retryDeadLetter } from '@/lib/api/client';
import { invoiceDocumentUrl } from '@/lib/api/urls';
import type {
  InvoiceDeadLetter,
  InvoiceFailure,
  InvoiceStatus,
} from '@/lib/api/schemas';
import { failureMessage } from '@/lib/invoices/failure-message';

export function StatusPanel({
  invoiceId,
  status,
  failure,
  deadLetter,
  retryGaveUp,
  onRetried,
}: {
  invoiceId: string;
  status: InvoiceStatus;
  failure: InvoiceFailure | null;
  deadLetter: InvoiceDeadLetter | null;
  retryGaveUp: boolean;
  onRetried: () => void;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryQueued, setRetryQueued] = useState(false);

  async function handleRetry() {
    setIsRetrying(true);
    setRetryError(null);
    setRetryQueued(false);
    try {
      const retried = await retryDeadLetter(invoiceId);
      if (!retried.ok) {
        setRetryError(describeApiError(retried.error, dictionary, 'retry'));
        return;
      }
      setRetryQueued(true);
      onRetried();
    } finally {
      setIsRetrying(false);
    }
  }

  if (!failure && !deadLetter && status !== 'READY') return null;

  return (
    <div className="flex flex-col gap-3">
      {failure && (
        <p className="text-sm text-error">
          {dictionary.review.failureLabel}:{' '}
          {failureMessage(failure, dictionary)}
        </p>
      )}

      {deadLetter && (
        <div className="flex flex-col gap-2 rounded-md border border-warning bg-warning-bg p-3">
          <p className="text-sm text-warning">
            {dictionary.review.deadLetterNotice(
              dictionary.pipelineStage[deadLetter.stage],
              new Date(deadLetter.failedAt).toLocaleString(locale),
            )}
          </p>
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={isRetrying}
            className="self-start rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-raised disabled:opacity-60"
          >
            {dictionary.review.retryButton}
          </button>
          {retryError && (
            <p role="alert" className="text-sm text-error">
              {retryError}
            </p>
          )}
          {retryGaveUp && !retryError && (
            <p role="status" className="text-sm text-warning">
              {dictionary.review.retryGaveUpNotice}
            </p>
          )}
          {retryQueued && !retryGaveUp && !retryError && (
            <p role="status" className="text-sm text-text-muted">
              {dictionary.review.retryQueuedNotice}
            </p>
          )}
        </div>
      )}

      {status === 'READY' && (
        <div className="flex flex-col gap-2">
          <a
            href={invoiceDocumentUrl(invoiceId)}
            className="self-start rounded-md bg-accent-bg px-4 py-2 text-sm font-medium text-accent-text hover:opacity-90"
          >
            {dictionary.review.downloadXml}
          </a>
          <p className="max-w-prose text-sm text-text-muted">
            {dictionary.review.readyDisclaimer}
          </p>
        </div>
      )}
    </div>
  );
}
