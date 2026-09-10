'use client';

import {
  MAX_DECIMAL_LENGTH,
  MAX_LINE_ITEMS,
  UNIT_OPTIONS,
} from '@pdf-to-xrechnung/contracts/review-input';
import { TrashIcon } from '@/components/icons';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import {
  annotationsFor,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import { fieldElementId } from '@/lib/review/findings';
import { Field } from './field';
import type { DraftLineItem } from '@/lib/review/draft';

const fieldOrder: (keyof DraftLineItem)[] = [
  'position',
  'description',
  'quantity',
  'unit',
  'unitPrice',
  'netAmount',
  'vatRate',
  'vatExemptionReason',
];

const numericFields = new Set<keyof DraftLineItem>([
  'quantity',
  'unitPrice',
  'netAmount',
  'vatRate',
]);

export function lineItemLimitReached(count: number): boolean {
  return count >= MAX_LINE_ITEMS;
}

export function LineItemsSection({
  lineItems,
  onChange,
  onAdd,
  onRemove,
  annotations,
  disabled,
}: {
  lineItems: DraftLineItem[];
  onChange: (
    index: number,
    field: keyof DraftLineItem,
    value: string | null,
  ) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  annotations: FieldAnnotations;
  disabled: boolean;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const atLimit = lineItemLimitReached(lineItems.length);
  const unitOptions = UNIT_OPTIONS.map((option) => ({
    value: option.value,
    label: locale === 'en' ? option.labelEn : option.labelDe,
  }));

  return (
    <fieldset>
      <legend className="mb-2 text-base font-semibold text-text">
        {dictionary.fields.lineItems}
      </legend>
      <p className="mb-3 text-sm text-text-muted">
        {dictionary.review.lineItemsHint}
      </p>
      <div className="flex flex-col gap-6">
        {lineItems.map((item, index) => (
          <div
            key={index}
            id={fieldElementId(`lineItems[${index}]`)}
            tabIndex={-1}
            className="rounded-md border border-border p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-muted">
                {dictionary.review.positionLabel(index + 1)}
              </h3>
              <button
                type="button"
                onClick={() => onRemove(index)}
                disabled={disabled}
                aria-label={dictionary.review.removeLineItem(index + 1)}
                title={dictionary.review.removeLineItem(index + 1)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-error transition-colors hover:bg-error-bg disabled:opacity-60"
              >
                <TrashIcon />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {fieldOrder.map((key) => {
                const path = `lineItems[${index}].${key}`;
                return (
                  <Field
                    key={key}
                    path={path}
                    label={dictionary.lineItem[key]}
                    value={item[key]}
                    onChange={(value) => onChange(index, key, value)}
                    numeric={numericFields.has(key)}
                    options={key === 'unit' ? unitOptions : undefined}
                    {...annotationsFor(annotations, path)}
                    disabled={disabled}
                    maxLength={
                      numericFields.has(key) ? MAX_DECIMAL_LENGTH : undefined
                    }
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {atLimit && (
        <p id="line-items-limit" className="mt-3 text-sm text-text-muted">
          {dictionary.review.lineItemsLimit(MAX_LINE_ITEMS)}
        </p>
      )}
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled || atLimit}
        aria-describedby={atLimit ? 'line-items-limit' : undefined}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-raised disabled:opacity-60"
      >
        {dictionary.review.addLineItem}
      </button>
    </fieldset>
  );
}
