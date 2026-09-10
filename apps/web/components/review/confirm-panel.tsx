'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';
import { formatFieldPath } from '@/lib/i18n/field-path';
import { ruleText } from '@/lib/review/findings';
import type { DraftChange } from '@/lib/review/draft';
import type { InvoiceFinding } from '@/lib/api/schemas';

const totalsPaths = ['netTotal', 'vatTotal', 'grossTotal'];

function isTouched(field: string, changed: ReadonlySet<string>): boolean {
  if (field === 'totals') return totalsPaths.some((path) => changed.has(path));
  for (const path of changed) {
    if (
      path === field ||
      path.startsWith(`${field}.`) ||
      path.startsWith(`${field}[`)
    ) {
      return true;
    }
  }
  return false;
}

export function ConfirmPanel({
  changes,
  blockingFindings,
  isSubmitting,
  error,
  onBack,
  onSubmit,
}: {
  changes: DraftChange[];
  blockingFindings: InvoiceFinding[];
  isSubmitting: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const dictionary = useDictionary();
  const changedPaths = new Set(changes.map((change) => change.path));

  const untouched = blockingFindings.filter(
    (finding) =>
      finding.field === null || !isTouched(finding.field, changedPaths),
  );
  const rechecked = blockingFindings.filter(
    (finding) => !untouched.includes(finding),
  );

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-base font-semibold text-text">
        {dictionary.review.confirmTitle}
      </h2>

      {changes.length === 0 ? (
        <p className="text-sm text-text-muted">
          {dictionary.review.confirmNoChanges}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-text">
            {dictionary.review.confirmChanged(changes.length)}
          </h3>
          <ul className="flex flex-col gap-1">
            {changes.map((change) => (
              <li
                key={change.path}
                className="grid grid-cols-1 gap-x-3 text-sm sm:grid-cols-[1fr_auto]"
              >
                <span className="text-text-muted">
                  {formatFieldPath(change.path, dictionary)}
                </span>
                <span className="tabular-nums text-text">
                  <span className="text-text-muted line-through">
                    {change.before ?? dictionary.review.emptyValue}
                  </span>
                  {' → '}
                  {change.after ?? dictionary.review.emptyValue}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {untouched.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-error">
            {dictionary.review.confirmUntouchedTitle}
          </h3>
          <p className="text-sm text-text-muted">
            {dictionary.review.confirmUntouchedHint}
          </p>
          <ul className="flex flex-col gap-1">
            {untouched.map((finding) => (
              <li
                key={`${finding.rule}-${finding.field ?? ''}`}
                className="text-sm text-text"
              >
                {formatFieldPath(finding.field, dictionary)} —{' '}
                {ruleText(finding, dictionary)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rechecked.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-warning">
            {dictionary.review.confirmRecheckedTitle}
          </h3>
          <p className="text-sm text-text-muted">
            {dictionary.review.confirmRecheckedHint}
          </p>
          <ul className="flex flex-col gap-1">
            {rechecked.map((finding) => (
              <li
                key={`${finding.rule}-${finding.field ?? ''}`}
                className="text-sm text-text"
              >
                {formatFieldPath(finding.field, dictionary)} —{' '}
                {ruleText(finding, dictionary)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <p className="text-sm text-text-muted">
        {dictionary.review.confirmFinalCheckHint}
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className="rounded-md bg-accent-bg px-4 py-2 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
        >
          {isSubmitting
            ? dictionary.review.submitting
            : dictionary.review.confirmSubmit}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={isSubmitting}
          className="rounded-md border border-border px-4 py-2 text-sm text-text hover:bg-surface-raised disabled:opacity-60"
        >
          {dictionary.review.confirmBack}
        </button>
      </div>
    </section>
  );
}
