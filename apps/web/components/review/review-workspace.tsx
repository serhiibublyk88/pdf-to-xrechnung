'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { submitInvoiceReview } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/error-message';
import type { RawExtractedInvoiceData } from '@/lib/api/schemas';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import { formatRemainingTime } from '@/lib/format/expiry';
import { useNow } from '@/lib/format/use-now';
import { resolvePipeline } from '@/lib/pipeline/stages';
import {
  annotationsFor,
  groupIssuesByField,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import {
  blockingFindings,
  dropStaleCollectionFindings,
  failedFindingsByField,
  fieldInputId,
} from '@/lib/review/findings';
import { diffDraft, draftIssues, toWire } from '@/lib/review/draft';
import {
  addLineItem,
  addVatBreakdown,
  removeLineItem,
  removeVatBreakdown,
  updateLineItem,
  updateParty,
  updateTopLevel,
  updateVatBreakdown,
} from '@/lib/review/raw-data';
import { useInvoiceReview } from '@/lib/review/use-invoice-review';
import { PipelineStepper } from '../pipeline-stepper';
import { PdfPanel } from './pdf-panel';
import { FindingsPanel } from './findings-panel';
import { StatusPanel } from './status-panel';
import { BlockingSummary } from './blocking-summary';
import { ConfirmPanel } from './confirm-panel';
import { HeaderSection } from './header-section';
import { PartySection } from './party-section';
import { LineItemsSection } from './line-items-section';
import { VatBreakdownSection } from './vat-breakdown-section';
import { TotalsSection } from './totals-section';
import { Field } from './field';

type Phase = 'form' | 'confirm';
type Tab = 'source' | 'review';

function LoadErrorNotice({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-current px-3 py-1.5 font-medium hover:opacity-80"
      >
        {retryLabel}
      </button>
    </div>
  );
}

export function ReviewWorkspace({ invoiceId }: { invoiceId: string }) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const now = useNow();
  const review = useInvoiceReview(invoiceId);
  const { detail, draft, originalDraft, status } = review;

  const [confirmingInvoiceId, setConfirmingInvoiceId] = useState<string | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>('review');
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [submittingInvoiceId, setSubmittingInvoiceId] = useState<string | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<{
    invoiceId: string;
    message: string;
  } | null>(null);
  const [wireMismatch, setWireMismatch] = useState<{
    invoiceId: string;
    paths: string[];
  } | null>(null);
  const phase: Phase = confirmingInvoiceId === invoiceId ? 'confirm' : 'form';
  const isSubmitting = submittingInvoiceId === invoiceId;
  const currentSubmitError =
    submitError?.invoiceId === invoiceId ? submitError.message : null;
  const issues = useMemo(
    () =>
      draft
        ? [
            ...draftIssues(draft),
            ...(wireMismatch?.invoiceId === invoiceId
              ? wireMismatch.paths
              : []
            ).map((path) => ({
              path,
              code: 'schemaMismatch' as const,
              blocking: true,
            })),
          ]
        : [],
    [draft, invoiceId, wireMismatch],
  );
  const changes = useMemo(
    () => (draft && originalDraft ? diffDraft(originalDraft, draft) : []),
    [draft, originalDraft],
  );
  const actionableFindings = useMemo(
    () =>
      dropStaleCollectionFindings(detail?.findings ?? [], {
        lineItemsRestructured: review.lineItemsRestructured,
        vatBreakdownRestructured: review.vatBreakdownRestructured,
      }),
    [
      detail?.findings,
      review.lineItemsRestructured,
      review.vatBreakdownRestructured,
    ],
  );
  const annotations: FieldAnnotations = useMemo(
    () => ({
      findings: failedFindingsByField(actionableFindings),
      issues: groupIssuesByField(issues),
      changedPaths: new Set(changes.map((change) => change.path)),
    }),
    [actionableFindings, issues, changes],
  );

  function handleReview() {
    if (!draft) return;
    const blocking = draftIssues(draft).filter((issue) => issue.blocking);
    if (blocking.length > 0) {
      const first = blocking[0];
      if (first) document.getElementById(fieldInputId(first.path))?.focus();
      return;
    }
    setSubmitError(null);
    setConfirmingInvoiceId(invoiceId);
  }

  async function handleSubmit() {
    if (!detail?.lifecycleToken || !draft) return;
    const wire = toWire(draft);
    if (!wire.ok) {
      setWireMismatch({ invoiceId, paths: wire.paths });
      setSubmitError({
        invoiceId,
        message: dictionary.review.formatIssuesTitle,
      });
      setConfirmingInvoiceId(null);
      return;
    }

    setWireMismatch(null);
    setSubmittingInvoiceId(invoiceId);
    setSubmitError(null);
    try {
      const submitted = await submitInvoiceReview(invoiceId, {
        lifecycleToken: detail.lifecycleToken,
        correctedData: wire.data satisfies RawExtractedInvoiceData,
      });

      if (!review.isCurrent()) return;

      if (!submitted.ok) {
        setSubmitError({
          invoiceId,
          message: describeApiError(submitted.error, dictionary, 'review'),
        });
        if (submitted.error.kind === 'conflict') {
          setConfirmingInvoiceId(null);
          review.onConflict();
          await review.replaceDetail();
        }
        return;
      }

      review.onSubmitted(submitted.data);
      setConfirmingInvoiceId(null);
      await review.replaceDetail();
    } finally {
      if (review.isCurrent()) setSubmittingInvoiceId(null);
    }
  }

  if (review.notFound) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <p className="text-text">{dictionary.errors.notFound}</p>
        <Link
          href={`/${locale}`}
          className="mt-3 inline-block text-sm underline"
        >
          {dictionary.review.backToList}
        </Link>
      </div>
    );
  }

  if (!status || !detail) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        {review.loadError ? (
          <LoadErrorNotice
            message={describeApiError(review.loadError, dictionary)}
            retryLabel={dictionary.common.retry}
            onRetry={() => void review.reload()}
          />
        ) : (
          <p className="text-text-muted">{dictionary.common.loading}</p>
        )}
      </div>
    );
  }

  const blocking = blockingFindings(actionableFindings);
  const pipeline = resolvePipeline({
    status: status.status,
    findings: detail.findings,
    deadLetter: detail.deadLetter,
    failure: status.failure,
    pageCount: status.pageCount,
    sourceType: status.sourceType,
    lineItemCount: detail.extractedData?.lineItems.length ?? null,
  });
  const formDisabled = detail.lifecycleToken === null || isSubmitting;

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/${locale}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-text hover:underline"
        >
          ← {dictionary.review.backToList}
        </Link>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setSourceCollapsed((collapsed) => !collapsed)}
            aria-expanded={!sourceCollapsed}
            aria-controls="source-panel"
            className="hidden text-sm text-text-muted underline-offset-2 hover:text-text hover:underline lg:inline"
          >
            {sourceCollapsed
              ? dictionary.review.showSource
              : dictionary.review.hideSource}
          </button>
          <p className="text-sm text-text-muted">
            {detail.originalFilename} · {dictionary.review.expiresLabel}{' '}
            {formatRemainingTime(detail.expiresAt, now, dictionary)}
          </p>
        </div>
      </div>

      {review.loadError && (
        <div className="mb-4">
          <LoadErrorNotice
            message={`${dictionary.review.loadFailedTitle} — ${describeApiError(review.loadError, dictionary)}`}
            retryLabel={dictionary.common.retry}
            onRetry={() => void review.reload()}
          />
        </div>
      )}

      <div
        role="tablist"
        aria-label={dictionary.review.sourceTitle}
        className="mb-4 flex gap-2 lg:hidden"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const next = tab === 'source' ? 'review' : 'source';
          setTab(next);
          document.getElementById(`${next}-tab`)?.focus();
        }}
      >
        {(['source', 'review'] as const).map((candidate) => (
          <button
            key={candidate}
            id={`${candidate}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            aria-controls={`${candidate}-panel`}
            tabIndex={tab === candidate ? 0 : -1}
            onClick={() => setTab(candidate)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              tab === candidate
                ? 'border-border bg-surface-raised text-text'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {candidate === 'source'
              ? dictionary.review.tabSource
              : dictionary.review.tabReview}
          </button>
        ))}
      </div>

      <div
        className={`grid grid-cols-1 items-start gap-8 ${
          sourceCollapsed
            ? 'lg:grid-cols-1'
            : 'lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]'
        }`}
      >
        <div
          id="source-panel"
          role="tabpanel"
          aria-labelledby="source-tab"
          className={`${tab === 'source' ? 'block' : 'hidden'} lg:sticky lg:top-6 ${
            sourceCollapsed ? 'lg:hidden' : 'lg:block'
          }`}
        >
          <PdfPanel invoiceId={invoiceId} />
        </div>

        <div
          id="review-panel"
          role="tabpanel"
          aria-labelledby="review-tab"
          className={`${tab === 'review' ? 'flex' : 'hidden'} flex-col gap-8 lg:flex`}
        >
          <PipelineStepper pipeline={pipeline} />

          <StatusPanel
            key={invoiceId}
            invoiceId={invoiceId}
            status={status.status}
            failure={status.failure}
            deadLetter={detail.deadLetter}
            retryGaveUp={review.retryGaveUp}
            onRetried={review.onRetried}
          />

          {review.submitResult && (
            <p
              role="status"
              className={`rounded-md border px-3 py-2 text-sm ${
                review.submitResult === 'GENERATING'
                  ? 'border-ok bg-ok-bg text-ok'
                  : 'border-warning bg-warning-bg text-warning'
              }`}
            >
              {review.submitResult === 'GENERATING'
                ? dictionary.review.submitResultGenerating
                : dictionary.review.submitResultNeedsReview}
            </p>
          )}

          {phase === 'confirm' && draft ? (
            <ConfirmPanel
              changes={changes}
              blockingFindings={blocking}
              isSubmitting={isSubmitting}
              error={currentSubmitError}
              onBack={() => setConfirmingInvoiceId(null)}
              onSubmit={() => void handleSubmit()}
            />
          ) : (
            draft && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  handleReview();
                }}
                className="flex flex-col gap-8"
              >
                <BlockingSummary findings={blocking} issues={issues} />

                <h2 className="text-lg font-semibold text-text">
                  {dictionary.review.correctionTitle}
                </h2>
                {status.sourceType === 'OCR' && (
                  <p className="rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">
                    {dictionary.review.ocrNotice}
                  </p>
                )}
                {detail.lifecycleToken === null && (
                  <p className="text-sm text-text-muted">
                    {dictionary.review.formDisabledNotice}
                  </p>
                )}

                <HeaderSection
                  data={draft}
                  onChange={(field, value) =>
                    review.editDraft((current) =>
                      updateTopLevel(current, field, value),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />

                <PartySection
                  which="seller"
                  party={draft.seller}
                  onChange={(field, value) =>
                    review.editDraft((current) =>
                      updateParty(current, 'seller', field, value),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {(['sellerIban', 'sellerBic'] as const).map((field) => (
                    <Field
                      key={field}
                      path={field}
                      label={dictionary.fields[field]}
                      value={draft[field]}
                      onChange={(value) =>
                        review.editDraft((current) =>
                          updateTopLevel(current, field, value),
                        )
                      }
                      {...annotationsFor(annotations, field)}
                      disabled={formDisabled}
                    />
                  ))}
                </div>

                <PartySection
                  which="buyer"
                  party={draft.buyer}
                  onChange={(field, value) =>
                    review.editDraft((current) =>
                      updateParty(current, 'buyer', field, value),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />

                <LineItemsSection
                  lineItems={draft.lineItems}
                  onChange={(index, field, value) =>
                    review.editDraft((current) =>
                      updateLineItem(current, index, field, value),
                    )
                  }
                  onAdd={() =>
                    review.restructureDraft('lineItems', addLineItem)
                  }
                  onRemove={(index) =>
                    review.restructureDraft('lineItems', (current) =>
                      removeLineItem(current, index),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />

                <VatBreakdownSection
                  vatBreakdown={draft.vatBreakdown}
                  onChange={(index, field, value) =>
                    review.editDraft((current) =>
                      updateVatBreakdown(current, index, field, value),
                    )
                  }
                  onAdd={() =>
                    review.restructureDraft('vatBreakdown', addVatBreakdown)
                  }
                  onRemove={(index) =>
                    review.restructureDraft('vatBreakdown', (current) =>
                      removeVatBreakdown(current, index),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />

                <TotalsSection
                  data={draft}
                  onChange={(field, value) =>
                    review.editDraft((current) =>
                      updateTopLevel(current, field, value),
                    )
                  }
                  annotations={annotations}
                  disabled={formDisabled}
                />

                {currentSubmitError && (
                  <p role="alert" className="text-sm text-error">
                    {currentSubmitError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={formDisabled}
                  className="self-start rounded-md bg-accent-bg px-4 py-2 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
                >
                  {dictionary.review.reviewAndSubmit}
                </button>
              </form>
            )
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold text-text">
              {dictionary.review.evidenceTitle}
            </h2>
            <FindingsPanel findings={detail.findings} />
          </section>
        </div>
      </div>
    </div>
  );
}
