'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';
import { formatFieldPath } from '@/lib/i18n/field-path';
import {
  ruleText,
  severityLabel,
  sortFindingsForDisplay,
} from '@/lib/review/findings';
import type { InvoiceFinding } from '@/lib/api/schemas';

const severityToneClasses: Record<InvoiceFinding['severity'], string> = {
  ERROR: 'text-error',
  WARNING: 'text-warning',
  INFO: 'text-text-muted',
};

function FindingRow({ finding }: { finding: InvoiceFinding }) {
  const dictionary = useDictionary();
  const tone = finding.passed
    ? 'text-text-muted'
    : severityToneClasses[finding.severity];

  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">
          {formatFieldPath(finding.field, dictionary)}
        </span>
        <span className={`text-xs font-medium ${tone}`}>
          {finding.passed
            ? dictionary.review.passedLabel
            : severityLabel(finding, dictionary)}
        </span>
      </div>
      <p className="text-sm text-text-muted">{ruleText(finding, dictionary)}</p>
      {!finding.passed &&
        (finding.expected !== null || finding.actual !== null) && (
          <p className="mt-1 text-xs tabular-nums text-text-muted">
            {finding.expected !== null && (
              <>
                {dictionary.review.expectedLabel}: {finding.expected}
              </>
            )}
            {finding.expected !== null && finding.actual !== null && ' · '}
            {finding.actual !== null && (
              <>
                {dictionary.review.actualLabel}: {finding.actual}
              </>
            )}
          </p>
        )}
    </li>
  );
}

export function FindingsPanel({ findings }: { findings: InvoiceFinding[] }) {
  const dictionary = useDictionary();

  if (findings.length === 0) {
    return <p className="text-text-muted">{dictionary.review.noFindings}</p>;
  }

  const sorted = sortFindingsForDisplay(findings);
  const failed = sorted.filter((finding) => !finding.passed).length;

  return (
    <details className="rounded-lg border border-border bg-surface p-4">
      <summary className="cursor-pointer text-sm text-text hover:text-text-muted">
        {dictionary.pipeline.fact.checks(findings.length - failed, failed)}
      </summary>
      <ul className="mt-3 flex flex-col gap-3">
        {sorted.map((finding, index) => (
          <FindingRow key={`${finding.rule}-${index}`} finding={finding} />
        ))}
      </ul>
    </details>
  );
}
