import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { VatBreakdownSection } from './vat-breakdown-section';
import type { FieldAnnotations } from '@/lib/review/annotations';
import { fieldMessageId } from '@/lib/review/findings';
import type { InvoiceFinding, VatBreakdown } from '@/lib/api/schemas';
import { MAX_VAT_BREAKDOWNS } from '@pdf-to-xrechnung/contracts/review-input';

const emptyAnnotations: FieldAnnotations = {
  findings: new Map(),
  issues: new Map(),
  changedPaths: new Set(),
};

const emptyEntry: VatBreakdown = {
  rate: null,
  base: null,
  amount: null,
  category: null,
  exemptionReason: null,
};

describe('VatBreakdownSection field wiring', () => {
  it('shows the value from the draft and forwards an edit with the index and field key', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[{ ...emptyEntry, rate: '19' }]}
          onChange={onChange}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('USt-Satz');
    expect((input as HTMLInputElement).value).toBe('19');

    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(0, 'rate', '7');
  });

  it('renders a finding on the field, bound by aria-describedby', () => {
    const finding: InvoiceFinding = {
      rule: 'test.marker_rule',
      field: 'vatBreakdown[0].rate',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: vat breakdown rate finding',
      expected: null,
      actual: null,
    };
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[emptyEntry]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={{
            findings: new Map([['vatBreakdown[0].rate', [finding]]]),
            issues: new Map(),
            changedPaths: new Set(),
          }}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('USt-Satz');
    expect(input.getAttribute('aria-describedby')).toBe(
      fieldMessageId('vatBreakdown[0].rate'),
    );
    expect(screen.getByText(/MARKER: vat breakdown rate finding/)).toBeTruthy();
  });

  it('propagates disabled to its fields', () => {
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[emptyEntry]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={true}
        />
      </DictionaryProvider>,
    );

    const rate = screen.getByLabelText('USt-Satz');
    expect(rate instanceof HTMLInputElement && rate.disabled).toBe(true);
  });

  it('shows the category value and forwards a category change', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[{ ...emptyEntry, category: 'S' }]}
          onChange={onChange}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const select = screen.getByLabelText('Steuerkategorie');
    expect((select as HTMLSelectElement).value).toBe('S');

    fireEvent.change(select, { target: { value: 'AE' } });
    expect(onChange).toHaveBeenCalledWith(0, 'category', 'AE');
  });

  it('shows the resolved reason for an implied category', () => {
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[{ ...emptyEntry, category: 'AE' }]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    expect(
      screen.getByText(
        'Wird übermittelt als: Steuerschuldnerschaft des Leistungsempfängers.',
      ),
    ).toBeTruthy();
  });

  it('shows the free-text reason hint only for the exempt (E) category', () => {
    const { rerender } = render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[{ ...emptyEntry, category: 'S' }]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );
    expect(
      screen.queryByText(/Der Befreiungsgrund oben ist der auf der Rechnung/),
    ).toBeNull();

    rerender(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={[{ ...emptyEntry, category: 'E' }]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );
    expect(
      screen.getByText(/Der Befreiungsgrund oben ist der auf der Rechnung/),
    ).toBeTruthy();
  });

  it('disables add at the shared VAT-breakdown maximum', () => {
    render(
      <DictionaryProvider locale="de">
        <VatBreakdownSection
          vatBreakdown={Array.from({ length: MAX_VAT_BREAKDOWNS }, () => ({
            ...emptyEntry,
          }))}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    expect(
      screen
        .getByRole('button', { name: 'Steuersatzgruppe hinzufügen' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});
