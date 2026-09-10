'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { deleteInvoice } from '@/lib/api/home-client';
import { invoiceDocumentUrl } from '@/lib/api/urls';
import { describeApiError } from '@/lib/api/error-message';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import {
  formatRemainingCompact,
  formatRemainingTime,
} from '@/lib/format/expiry';
import { useNow } from '@/lib/format/use-now';
import { resolvePipeline } from '@/lib/pipeline/stages';
import { groupInvoices } from '@/lib/review/grouping';
import { ClockIcon, DownloadIcon, TrashIcon } from './icons';
import { CompactPipeline } from './pipeline-stepper';
import { terminalStatuses, type InvoiceListItem } from '@/lib/api/base-schemas';

function rowElementId(invoiceId: string): string {
  return `invoice-row-${invoiceId}`;
}

function InvoiceRow({
  invoice,
  now,
  highlighted,
  onRequestDelete,
}: {
  invoice: InvoiceListItem;
  now: Date;
  highlighted: boolean;
  onRequestDelete: (invoice: InvoiceListItem) => void;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const pipeline = resolvePipeline({
    status: invoice.status,
    failure: invoice.failure,
  });

  return (
    <li
      id={rowElementId(invoice.id)}
      className={`flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 transition-colors last:border-b-0 ${
        highlighted ? 'bg-surface-raised' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <Link
          href={`/${locale}/invoices/${invoice.id}`}
          className="block truncate font-medium text-text underline-offset-2 hover:underline"
        >
          {invoice.originalFilename}
        </Link>
        <div className="mt-1.5">
          <CompactPipeline
            pipeline={pipeline}
            trailing={
              <span
                title={formatRemainingTime(invoice.expiresAt, now, dictionary)}
                className="ml-4 flex cursor-default items-center gap-1"
              >
                <ClockIcon />
                <span className="tabular-nums" aria-hidden="true">
                  {formatRemainingCompact(invoice.expiresAt, now)}
                </span>
                <span className="sr-only">
                  {formatRemainingTime(invoice.expiresAt, now, dictionary)}
                </span>
              </span>
            }
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {invoice.status === 'READY' ? (
          <a
            href={invoiceDocumentUrl(invoice.id)}
            aria-label={dictionary.common.download}
            title={dictionary.common.download}
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            <DownloadIcon />
          </a>
        ) : (
          <span aria-hidden="true" className="h-9 w-9" />
        )}
        {terminalStatuses.has(invoice.status) ? (
          <button
            type="button"
            onClick={() => onRequestDelete(invoice)}
            aria-label={dictionary.upload.delete.action}
            title={dictionary.upload.delete.action}
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-error-bg hover:text-error"
          >
            <TrashIcon />
          </button>
        ) : (
          <span aria-hidden="true" className="h-9 w-9" />
        )}
      </div>
    </li>
  );
}
function ConfirmDeleteDialog({
  dialogRef,
  invoice,
  isDeleting,
  errorMessage,
  onDismissed,
  onConfirm,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  invoice: InvoiceListItem;
  isDeleting: boolean;
  errorMessage: string | null;
  onDismissed: () => void;
  onConfirm: () => void;
}) {
  const dictionary = useDictionary();

  useEffect(() => {
    dialogRef.current?.showModal();
  }, [dialogRef]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delete-invoice-title"
      aria-describedby="delete-invoice-body"
      onCancel={(event) => {
        if (isDeleting) event.preventDefault();
      }}
      onClose={onDismissed}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface-raised p-6 text-text shadow-2xl backdrop:bg-black/60"
    >
      <h2 id="delete-invoice-title" className="text-lg font-semibold">
        {dictionary.upload.delete.title}
      </h2>
      <p
        id="delete-invoice-body"
        className="mt-2 text-sm leading-relaxed text-pretty text-text-muted"
      >
        {dictionary.upload.delete.body(invoice.originalFilename)}
      </p>
      {errorMessage && (
        <p role="alert" className="mt-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        {/* The safe action holds the initial focus, so Enter never deletes. */}
        <button
          type="button"
          autoFocus
          onClick={() => dialogRef.current?.close()}
          disabled={isDeleting}
          className="h-10 rounded-md border border-border px-4 text-sm font-medium text-text transition-colors hover:bg-surface disabled:opacity-50"
        >
          {dictionary.upload.delete.cancel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isDeleting}
          className="h-10 rounded-md bg-error px-4 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {dictionary.upload.delete.confirm}
        </button>
      </div>
    </dialog>
  );
}

export function InvoiceList({
  invoices,
  highlightId,
  onDeleted,
}: {
  invoices: InvoiceListItem[];
  highlightId: string | null;
  onDeleted: (id: string) => void;
}) {
  const dictionary = useDictionary();
  const now = useNow();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pendingDelete, setPendingDelete] = useState<InvoiceListItem | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!highlightId) return;
    const row = document.getElementById(rowElementId(highlightId));
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlightId]);

  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    listRef.current?.focus();
  }, [invoices]);

  function dismissDialog() {
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    setIsDeleting(true);
    const result = await deleteInvoice(pendingDelete.id);
    setIsDeleting(false);
    if (!result.ok) {
      setDeleteError(describeApiError(result.error, dictionary, 'retry'));
      return;
    }
    onDeleted(pendingDelete.id);
    dialogRef.current?.close();
    restoreFocusRef.current = true;
  }

  if (invoices.length === 0) {
    return (
      <div
        ref={listRef}
        tabIndex={-1}
        className="rounded-lg border border-border bg-surface p-6"
      >
        <h3 className="mb-2 text-base font-semibold text-text">
          {dictionary.upload.emptyTitle}
        </h3>
        <p className="mb-4 max-w-prose text-sm text-text-muted">
          {dictionary.upload.emptyIntro}
        </p>
        <ul className="flex flex-col gap-1">
          {dictionary.upload.emptyPoints.map((point) => (
            <li key={point} className="text-sm text-text-muted">
              · {point}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div ref={listRef} tabIndex={-1} className="flex flex-col gap-8">
      {groupInvoices(invoices).map((group) => (
        <section key={group.id}>
          <h3 className="mb-1 text-sm font-medium tracking-wide text-text-muted">
            {dictionary.upload.groups[group.id]} · {group.invoices.length}
          </h3>
          <ul className="flex flex-col">
            {group.invoices.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                now={now}
                highlighted={invoice.id === highlightId}
                onRequestDelete={setPendingDelete}
              />
            ))}
          </ul>
        </section>
      ))}
      {pendingDelete && (
        <ConfirmDeleteDialog
          dialogRef={dialogRef}
          invoice={pendingDelete}
          isDeleting={isDeleting}
          errorMessage={deleteError}
          onDismissed={dismissDialog}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
