'use client';

import {
  MAX_DECIMAL_LENGTH,
  MAX_VAT_BREAKDOWNS,
  VAT_CATEGORY_CODES,
} from '@pdf-to-xrechnung/contracts/review-input';
import { TrashIcon } from '@/components/icons';
import { useDictionary } from '@/lib/i18n/dictionary-context';
import {
  annotationsFor,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import { fieldElementId } from '@/lib/review/findings';
import { Field } from './field';
import type { VatBreakdown } from '@/lib/api/schemas';

const fieldOrder: (keyof VatBreakdown)[] = [
  'rate',
  'base',
  'amount',
  'category',
  'exemptionReason',
];

const numericFields = new Set<keyof VatBreakdown>(['rate', 'base', 'amount']);

export function VatBreakdownSection({
  vatBreakdown,
  onChange,
  onAdd,
  onRemove,
  annotations,
  disabled,
}: {
  vatBreakdown: VatBreakdown[];
  onChange: (
    index: number,
    field: keyof VatBreakdown,
    value: string | null,
  ) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  annotations: FieldAnnotations;
  disabled: boolean;
}) {
  const dictionary = useDictionary();
  const atLimit = vatBreakdown.length >= MAX_VAT_BREAKDOWNS;
  const categoryOptions = VAT_CATEGORY_CODES.map((code) => ({
    value: code,
    label: dictionary.review.vatCategoryOptions[code],
  }));

  return (
    <fieldset>
      <legend className="mb-2 text-base font-semibold text-text">
        {dictionary.fields.vatBreakdown}
      </legend>
      <p className="mb-3 text-sm text-text-muted">
        {dictionary.review.vatBreakdownHint}
      </p>
      <div className="flex flex-col gap-6">
        {vatBreakdown.map((entry, index) => (
          <div
            key={index}
            id={fieldElementId(`vatBreakdown[${index}]`)}
            tabIndex={-1}
            className="rounded-md border border-border p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-muted">
                {dictionary.review.vatGroupLabel(index + 1)}
              </h3>
              <button
                type="button"
                onClick={() => onRemove(index)}
                disabled={disabled}
                aria-label={dictionary.review.removeVatBreakdown(index + 1)}
                title={dictionary.review.removeVatBreakdown(index + 1)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-error transition-colors hover:bg-error-bg disabled:opacity-60"
              >
                <TrashIcon />
              </button>
            </div>
            <p className="mb-3 text-sm text-text-muted">
              {dictionary.review.vatCategoryHint}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {fieldOrder.map((key) => {
                const path = `vatBreakdown[${index}].${key}`;
                return (
                  <Field
                    key={key}
                    path={path}
                    label={dictionary.vatBreakdownField[key]}
                    value={entry[key]}
                    onChange={(value) => onChange(index, key, value)}
                    numeric={numericFields.has(key)}
                    options={key === 'category' ? categoryOptions : undefined}
                    {...annotationsFor(annotations, path)}
                    disabled={disabled}
                    maxLength={
                      numericFields.has(key) ? MAX_DECIMAL_LENGTH : undefined
                    }
                  />
                );
              })}
            </div>
            {entry.category !== null &&
              dictionary.review.vatCategoryResolvedReason(entry.category) !==
                null && (
                <p className="mt-3 text-sm text-text-muted">
                  {dictionary.review.vatCategoryResolvedReason(entry.category)}
                </p>
              )}
            {entry.category === 'E' && (
              <p className="mt-3 text-sm text-text-muted">
                {dictionary.review.vatCategoryReasonHint}
              </p>
            )}
          </div>
        ))}
      </div>
      {atLimit && (
        <p id="vat-breakdown-limit" className="mt-3 text-sm text-text-muted">
          {dictionary.review.vatBreakdownLimit(MAX_VAT_BREAKDOWNS)}
        </p>
      )}
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled || atLimit}
        aria-describedby={atLimit ? 'vat-breakdown-limit' : undefined}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-raised disabled:opacity-60"
      >
        {dictionary.review.addVatBreakdown}
      </button>
    </fieldset>
  );
}
