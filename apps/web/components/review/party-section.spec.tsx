import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { COUNTRY_CODES } from '@pdf-to-xrechnung/contracts';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import type { InvoiceFinding, Party } from '@/lib/api/schemas';
import type { FieldAnnotations } from '@/lib/review/annotations';
import { fieldMessageId } from '@/lib/review/findings';
import { PartySection } from './party-section';

const emptyAnnotations: FieldAnnotations = {
  findings: new Map(),
  issues: new Map(),
  changedPaths: new Set(),
};

const party: Party = {
  name: null,
  street: null,
  postalCode: null,
  city: null,
  countryCode: null,
  vatId: null,
  taxNumber: null,
  electronicAddress: null,
  electronicAddressScheme: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
};

describe('PartySection country options', () => {
  it('offers exactly the codes supported by the XRechnung profile', () => {
    render(
      <DictionaryProvider locale="de">
        <PartySection
          which="seller"
          party={party}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const codes = screen.getByLabelText('Land').querySelectorAll('option');
    expect([...codes].slice(1).map((option) => option.value)).toEqual(
      COUNTRY_CODES,
    );
  });
});

describe('PartySection field wiring', () => {
  it('shows the value from the party and forwards an edit with the field key', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <PartySection
          which="seller"
          party={{ ...party, name: 'Musterhandel GmbH' }}
          onChange={onChange}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Name');
    expect((input as HTMLInputElement).value).toBe('Musterhandel GmbH');

    fireEvent.change(input, { target: { value: 'Neuer Name GmbH' } });
    expect(onChange).toHaveBeenCalledWith('name', 'Neuer Name GmbH');
  });

  it('renders a finding on the field, bound by aria-describedby', () => {
    const finding: InvoiceFinding = {
      rule: 'test.marker_rule',
      field: 'seller.name',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: seller name finding',
      expected: null,
      actual: null,
    };
    render(
      <DictionaryProvider locale="de">
        <PartySection
          which="seller"
          party={party}
          onChange={() => {}}
          annotations={{
            findings: new Map([['seller.name', [finding]]]),
            issues: new Map(),
            changedPaths: new Set(),
          }}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-describedby')).toBe(
      fieldMessageId('seller.name'),
    );
    expect(screen.getByText(/MARKER: seller name finding/)).toBeTruthy();
  });

  it('propagates disabled to its fields', () => {
    render(
      <DictionaryProvider locale="de">
        <PartySection
          which="seller"
          party={party}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={true}
        />
      </DictionaryProvider>,
    );

    const name = screen.getByLabelText('Name');
    const country = screen.getByLabelText('Land');
    expect(name instanceof HTMLInputElement && name.disabled).toBe(true);
    expect(country instanceof HTMLSelectElement && country.disabled).toBe(true);
  });
});
