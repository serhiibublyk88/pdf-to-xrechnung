'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';
import {
  annotationsFor,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import { Field } from './field';
import type { InvoiceDraft } from '@/lib/review/draft';
import { MAX_DECIMAL_LENGTH } from '@pdf-to-xrechnung/contracts/review-input';

const totalsFields = ['netTotal', 'vatTotal', 'grossTotal'] as const;

export function TotalsSection({
  data,
  onChange,
  annotations,
  disabled,
}: {
  data: InvoiceDraft;
  onChange: (
    field: (typeof totalsFields)[number],
    value: string | null,
  ) => void;
  annotations: FieldAnnotations;
  disabled: boolean;
}) {
  const dictionary = useDictionary();

  return (
    <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-base font-semibold text-text">
        {dictionary.review.groups.totals}
      </legend>
      {totalsFields.map((key) => (
        <Field
          key={key}
          path={key}
          label={dictionary.fields[key]}
          value={data[key]}
          onChange={(value) => onChange(key, value)}
          numeric
          {...annotationsFor(annotations, key)}
          disabled={disabled}
          maxLength={MAX_DECIMAL_LENGTH}
        />
      ))}
    </fieldset>
  );
}
