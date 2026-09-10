import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { TotalsSection } from './totals-section';
import type { InvoiceDraft } from '@/lib/review/draft';
import type { FieldAnnotations } from '@/lib/review/annotations';
import { fieldMessageId } from '@/lib/review/findings';
import type { InvoiceFinding } from '@/lib/api/schemas';
import { MAX_DECIMAL_LENGTH } from '@pdf-to-xrechnung/contracts/review-input';

const emptyAnnotations: FieldAnnotations = {
  findings: new Map(),
  issues: new Map(),
  changedPaths: new Set(),
};

const emptyParty = {
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

const draft: InvoiceDraft = {
  invoiceNumber: null,
  issueDate: null,
  dueDate: null,
  deliveryDate: null,
  currency: null,
  seller: emptyParty,
  buyer: emptyParty,
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

describe('TotalsSection field wiring', () => {
  it('shows the value from the draft and forwards an edit with the field key', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <TotalsSection
          data={{ ...draft, netTotal: '1190.00' }}
          onChange={onChange}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Nettosumme');
    expect((input as HTMLInputElement).value).toBe('1190.00');

    fireEvent.change(input, { target: { value: '1200.00' } });
    expect(onChange).toHaveBeenCalledWith('netTotal', '1200.00');
  });

  it('bounds every monetary total to the shared decimal limit', () => {
    render(
      <DictionaryProvider locale="de">
        <TotalsSection
          data={draft}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    for (const label of [
      'Nettosumme',
      'Umsatzsteuergesamtbetrag',
      'Rechnungsendbetrag',
    ]) {
      expect(screen.getByLabelText(label).getAttribute('maxLength')).toBe(
        String(MAX_DECIMAL_LENGTH),
      );
    }
  });

  it('renders a finding on the field, bound by aria-describedby', () => {
    const finding: InvoiceFinding = {
      rule: 'test.marker_rule',
      field: 'netTotal',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: net total finding',
      expected: null,
      actual: null,
    };
    render(
      <DictionaryProvider locale="de">
        <TotalsSection
          data={draft}
          onChange={() => {}}
          annotations={{
            findings: new Map([['netTotal', [finding]]]),
            issues: new Map(),
            changedPaths: new Set(),
          }}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Nettosumme');
    expect(input.getAttribute('aria-describedby')).toBe(
      fieldMessageId('netTotal'),
    );
    expect(screen.getByText(/MARKER: net total finding/)).toBeTruthy();
  });

  it('propagates disabled to its fields', () => {
    render(
      <DictionaryProvider locale="de">
        <TotalsSection
          data={draft}
          onChange={() => {}}
          annotations={emptyAnnotations}
          disabled={true}
        />
      </DictionaryProvider>,
    );

    const netTotal = screen.getByLabelText('Nettosumme');
    const grossTotal = screen.getByLabelText('Rechnungsendbetrag');
    expect(netTotal instanceof HTMLInputElement && netTotal.disabled).toBe(
      true,
    );
    expect(grossTotal instanceof HTMLInputElement && grossTotal.disabled).toBe(
      true,
    );
  });
});
