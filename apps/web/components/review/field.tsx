'use client';

import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import {
  fieldElementId,
  fieldInputId,
  fieldMessageId,
  ruleText,
  severityLabel,
} from '@/lib/review/findings';
import type { FieldIssue } from '@/lib/review/draft';
import {
  canonicalDecimalPattern,
  MAX_TEXT_LENGTH,
} from '@pdf-to-xrechnung/contracts/review-input';
import type { InvoiceFinding } from '@/lib/api/schemas';

const MAX_INTL_FRACTION_DIGITS = 100;

export function localizedEcho(
  value: string | null,
  locale: string,
): string | null {
  if (value === null || !canonicalDecimalPattern.test(value)) return null;
  const fractionDigits = Math.min(
    value.split('.')[1]?.length ?? 0,
    MAX_INTL_FRACTION_DIGITS,
  );
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value as `${number}`);
  return formatted === value ? null : formatted;
}

export function Field({
  path,
  label,
  value,
  onChange,
  type = 'text',
  numeric = false,
  options,
  findings = [],
  issues = [],
  disabled = false,
  maxLength = MAX_TEXT_LENGTH,
}: {
  path: string;
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  type?: 'text' | 'date';
  numeric?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  findings?: InvoiceFinding[];
  issues?: FieldIssue[];
  disabled?: boolean;
  maxLength?: number;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();

  const inputId = fieldInputId(path);
  const messageId = fieldMessageId(path);
  const blocking = issues.some((issue) => issue.blocking);
  const hasError =
    blocking || findings.some((finding) => finding.severity === 'ERROR');
  const hasMessages = findings.length > 0 || issues.length > 0;
  const echo = numeric ? localizedEcho(value, locale) : null;

  const borderClass = hasError
    ? 'border-error'
    : findings.length > 0
      ? 'border-warning'
      : 'border-border';

  const currentValueIsUnknownOption =
    options !== undefined &&
    value !== null &&
    !options.some((option) => option.value === value);

  return (
    <div id={fieldElementId(path)}>
      <label htmlFor={inputId} className="mb-1 block text-sm text-text-muted">
        {label}
      </label>
      <div className="flex items-baseline gap-2">
        {options ? (
          <select
            id={inputId}
            value={value ?? ''}
            disabled={disabled}
            aria-invalid={hasError}
            aria-describedby={hasMessages ? messageId : undefined}
            onChange={(event) =>
              onChange(event.target.value === '' ? null : event.target.value)
            }
            className={`w-full rounded-md border bg-surface px-3 py-1.5 text-text disabled:opacity-60 ${borderClass}`}
          >
            <option value="">{dictionary.review.selectPlaceholder}</option>
            {currentValueIsUnknownOption && value !== null && (
              <option value={value}>
                {dictionary.review.unrecognizedOptionLabel(value)}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={inputId}
            type={type}
            inputMode={numeric ? 'decimal' : undefined}
            value={value ?? ''}
            disabled={disabled}
            maxLength={maxLength}
            aria-invalid={hasError}
            aria-describedby={hasMessages ? messageId : undefined}
            onChange={(event) =>
              onChange(event.target.value === '' ? null : event.target.value)
            }
            className={`w-full rounded-md border bg-surface px-3 py-1.5 text-text disabled:opacity-60 ${borderClass} ${
              numeric ? 'tabular-nums' : ''
            }`}
          />
        )}
        {echo && (
          <span
            aria-hidden="true"
            className="shrink-0 text-sm tabular-nums text-text-muted"
          >
            {echo}
          </span>
        )}
      </div>

      {hasMessages && (
        <div id={messageId} className="mt-1 flex flex-col gap-1">
          {findings.map((finding) => (
            <p
              key={finding.rule}
              className={`text-xs ${
                finding.severity === 'ERROR' ? 'text-error' : 'text-warning'
              }`}
            >
              <span className="font-medium">
                {severityLabel(finding, dictionary)}
              </span>
              {' · '}
              {ruleText(finding, dictionary)}
              {(finding.expected !== null || finding.actual !== null) && (
                <span className="text-text-muted">
                  {finding.expected !== null &&
                    ` ${dictionary.review.expectedLabel}: ${finding.expected}`}
                  {finding.actual !== null &&
                    ` ${dictionary.review.actualLabel}: ${finding.actual}`}
                </span>
              )}
            </p>
          ))}
          {issues.map((issue) => (
            <p
              key={`${issue.code}-${issue.path}`}
              className={`text-xs ${issue.blocking ? 'text-error' : 'text-warning'}`}
            >
              <span className="font-medium">
                {issue.blocking
                  ? dictionary.severity.ERROR
                  : dictionary.severity.WARNING}
              </span>
              {' · '}
              {issue.code === 'thousandsSeparator'
                ? dictionary.issues.thousandsSeparator(value ?? '')
                : dictionary.issues[issue.code]}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
