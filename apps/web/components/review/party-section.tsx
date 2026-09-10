'use client';

import {
  COUNTRY_CODES,
  ELECTRONIC_ADDRESS_SCHEMES,
  MAX_VAT_ID_LENGTH,
} from '@pdf-to-xrechnung/contracts/review-input';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';
import {
  annotationsFor,
  hasAnyAnnotation,
  type FieldAnnotations,
} from '@/lib/review/annotations';
import { Field } from './field';
import type { Party } from '@/lib/api/schemas';

const electronicAddressSchemeOptions = ELECTRONIC_ADDRESS_SCHEMES.map(
  (code) => ({ value: code, label: code }),
);

const addressFields: (keyof Party)[] = [
  'name',
  'street',
  'postalCode',
  'city',
  'countryCode',
];
const identifierFields: (keyof Party)[] = ['vatId', 'taxNumber'];
const contactFields: (keyof Party)[] = [
  'electronicAddress',
  'electronicAddressScheme',
  'contactName',
  'contactEmail',
  'contactPhone',
];

export function PartySection({
  which,
  party,
  onChange,
  annotations,
  disabled,
}: {
  which: 'seller' | 'buyer';
  party: Party;
  onChange: (field: keyof Party, value: string | null) => void;
  annotations: FieldAnnotations;
  disabled: boolean;
}) {
  const dictionary = useDictionary();
  const locale = useLocale();
  const countryNames = new Intl.DisplayNames([locale], { type: 'region' });
  const countryOptions = COUNTRY_CODES.map((code) => ({
    value: code,
    label: `${code} – ${
      /^[A-Z]{2}$/.test(code) ? (countryNames.of(code) ?? code) : code
    }`,
  }));
  const path = (field: keyof Party) => `${which}.${field}`;

  const renderField = (field: keyof Party) => (
    <Field
      key={field}
      path={path(field)}
      label={dictionary.party[field]}
      value={party[field]}
      onChange={(value) => onChange(field, value)}
      options={
        field === 'electronicAddressScheme'
          ? electronicAddressSchemeOptions
          : field === 'countryCode'
            ? countryOptions
            : undefined
      }
      {...annotationsFor(annotations, path(field))}
      disabled={disabled}
      maxLength={field === 'vatId' ? MAX_VAT_ID_LENGTH : undefined}
    />
  );

  const contactHasProblem = hasAnyAnnotation(
    annotations,
    contactFields.map(path),
  );

  const partyLabel = dictionary.fields[which];

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 text-base font-semibold text-text">
        {partyLabel}
      </legend>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {addressFields.map(renderField)}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-text-muted">
          {dictionary.review.identifiersHint}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {identifierFields.map(renderField)}
        </div>
      </div>

      <details open={contactHasProblem}>
        <summary className="cursor-pointer text-sm text-text-muted hover:text-text">
          {dictionary.review.contactDetails(partyLabel)}
        </summary>
        <p className="mt-4 text-sm text-text-muted">
          {dictionary.review.contactHint}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {contactFields.map(renderField)}
        </div>
      </details>
    </fieldset>
  );
}
