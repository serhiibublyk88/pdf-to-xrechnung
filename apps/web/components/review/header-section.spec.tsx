import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CURRENCY_CODES } from '@pdf-to-xrechnung/contracts';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import type { InvoiceDraft } from '@/lib/review/draft';
import type { FieldAnnotations } from '@/lib/review/annotations';
import { fieldMessageId } from '@/lib/review/findings';
import type { InvoiceFinding } from '@/lib/api/schemas';
import { HeaderSection } from './header-section';

const emptyAnnotations: FieldAnnotations = {
  findings: new Map(),
  issues: new Map(),
  changedPaths: new Set(),
};

const draft: InvoiceDraft = {
  invoiceNumber: null,
  issueDate: null,
  dueDate: null,
  deliveryDate: null,
  currency: null,
  seller: {
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
  },
  buyer: {
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
  },
  sellerIban: null,
  sellerBic: null,
  lineItems: [],
  netTotal: null,
  vatBreakdown: [],
  vatTotal: null,
  grossTotal: null,
  paymentTerms: null,
  buyerReference: null,
};

describe('HeaderSection currency options', () => {
  it('offers exactly the codes supported by the XRechnung profile', () => {
    render(
      <DictionaryProvider locale="de">
        <HeaderSection
          data={draft}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const codes = screen.getByLabelText('Währung').querySelectorAll('option');
    expect([...codes].slice(1).map((option) => option.value)).toEqual(
      CURRENCY_CODES,
    );
  });
});

describe('HeaderSection field wiring', () => {
  it('shows the value from the draft and forwards an edit with the field key', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <HeaderSection
          data={{ ...draft, invoiceNumber: 'RE-2026-01' }}
          onChange={onChange}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Rechnungsnummer');
    expect((input as HTMLInputElement).value).toBe('RE-2026-01');

    fireEvent.change(input, { target: { value: 'RE-2026-02' } });
    expect(onChange).toHaveBeenCalledWith('invoiceNumber', 'RE-2026-02');
  });

  it('renders a finding on the field, bound by aria-describedby', () => {
    const finding: InvoiceFinding = {
      rule: 'test.marker_rule',
      field: 'invoiceNumber',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: invoice number finding',
      expected: null,
      actual: null,
    };
    render(
      <DictionaryProvider locale="de">
        <HeaderSection
          data={draft}
          onChange={() => {}}
          annotations={{
            findings: new Map([['invoiceNumber', [finding]]]),
            issues: new Map(),
            changedPaths: new Set(),
          }}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Rechnungsnummer');
    expect(input.getAttribute('aria-describedby')).toBe(
      fieldMessageId('invoiceNumber'),
    );
    expect(screen.getByText(/MARKER: invoice number finding/)).toBeTruthy();
  });

  it('propagates disabled to its fields', () => {
    render(
      <DictionaryProvider locale="de">
        <HeaderSection
          data={draft}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={true}
        />
      </DictionaryProvider>,
    );

    const invoiceNumber = screen.getByLabelText('Rechnungsnummer');
    const currency = screen.getByLabelText('Währung');
    expect(
      invoiceNumber instanceof HTMLInputElement && invoiceNumber.disabled,
    ).toBe(true);
    expect(currency instanceof HTMLSelectElement && currency.disabled).toBe(
      true,
    );
  });
});
