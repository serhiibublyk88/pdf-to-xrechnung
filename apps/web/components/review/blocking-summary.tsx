'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';
import { formatFieldPath } from '@/lib/i18n/field-path';
import { fieldElementId, fieldInputId, ruleText } from '@/lib/review/findings';
import type { FieldIssue } from '@/lib/review/draft';
import type { InvoiceFinding } from '@/lib/api/schemas';

function FieldJump({ path, label }: { path: string; label: string }) {
  return (
    <a
      href={`#${fieldElementId(path)}`}
      onClick={(event) => {
        const target =
          document.getElementById(fieldInputId(path)) ??
          document.getElementById(fieldElementId(path));
        if (!target) return;
        event.preventDefault();
        const reducedMotion = window.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        target.scrollIntoView({
          block: 'center',
          behavior: reducedMotion ? 'auto' : 'smooth',
        });
        target.focus({ preventScroll: true });
      }}
      className="text-sm text-text underline underline-offset-2 hover:no-underline"
    >
      {label}
    </a>
  );
}

export function BlockingSummary({
  findings,
  issues,
}: {
  findings: InvoiceFinding[];
  issues: FieldIssue[];
}) {
  const dictionary = useDictionary();
  const blockingIssues = issues.filter((issue) => issue.blocking);

  if (findings.length === 0 && blockingIssues.length === 0) return null;

  const withField = findings.flatMap((finding) =>
    finding.field !== null ? [{ finding, field: finding.field }] : [],
  );
  const withoutField = findings.filter((finding) => finding.field === null);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-error bg-error-bg p-4">
      {findings.length > 0 && (
        <p className="text-sm font-medium text-error">
          {dictionary.review.blockingTitle(findings.length)}
        </p>
      )}

      {withoutField.length > 0 && (
        <ul className="flex flex-col gap-1">
          {withoutField.map((finding, index) => (
            <li key={`${finding.rule}-${index}`} className="text-sm text-text">
              {ruleText(finding, dictionary)}
            </li>
          ))}
        </ul>
      )}

      {withField.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text-muted">
            {dictionary.review.blockingHint}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {withField.map(({ finding, field }) => (
              <li key={`${finding.rule}-${field}`}>
                <FieldJump
                  path={field}
                  label={formatFieldPath(field, dictionary)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {blockingIssues.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-error pt-3">
          <p className="text-sm font-medium text-error">
            {dictionary.review.formatIssuesTitle}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {blockingIssues.map((issue) => (
              <li key={issue.path}>
                <FieldJump
                  path={issue.path}
                  label={formatFieldPath(issue.path, dictionary)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
