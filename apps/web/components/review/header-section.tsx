'use client';

import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import {
  annotationsFor,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import { CURRENCY_CODES } from '@pdf-to-xrechnung/contracts/review-input';
import { Field } from './field';
import type { InvoiceDraft } from '@/lib/review/draft';

const dateFields = ['issueDate', 'dueDate', 'deliveryDate'] as const;
const otherFields = [
  'invoiceNumber',
  'currency',
  'buyerReference',
  'paymentTerms',
] as const;

export function HeaderSection({
  data,
  onChange,
  annotations,
  disabled,
}: {
  data: InvoiceDraft;
  onChange: (
    field: (typeof dateFields)[number] | (typeof otherFields)[number],
    value: string | null,
  ) => void;
  annotations: FieldAnnotations;
  disabled: boolean;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const currencyNames = new Intl.DisplayNames([locale], { type: 'currency' });
  const currencyOptions = CURRENCY_CODES.map((code) => ({
    value: code,
    label: `${code} – ${currencyNames.of(code) ?? code}`,
  }));

  return (
    <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-base font-semibold text-text">
        {dictionary.review.groups.header}
      </legend>
      {dateFields.map((key) => (
        <Field
          key={key}
          path={key}
          label={dictionary.fields[key]}
          value={data[key]}
          onChange={(value) => onChange(key, value)}
          type="date"
          {...annotationsFor(annotations, key)}
          disabled={disabled}
        />
      ))}
      {otherFields.map((key) => (
        <Field
          key={key}
          path={key}
          label={dictionary.fields[key]}
          value={data[key]}
          onChange={(value) => onChange(key, value)}
          options={key === 'currency' ? currencyOptions : undefined}
          {...annotationsFor(annotations, key)}
          disabled={disabled}
        />
      ))}
    </fieldset>
  );
}
