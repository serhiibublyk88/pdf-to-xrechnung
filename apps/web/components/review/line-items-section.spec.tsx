import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { LineItemsSection, lineItemLimitReached } from './line-items-section';
import { emptyDraftLineItem } from '@/lib/review/draft';
import type { FieldAnnotations } from '@/lib/review/annotations';
import { fieldMessageId } from '@/lib/review/findings';
import type { InvoiceFinding } from '@/lib/api/schemas';
import { MAX_LINE_ITEMS } from '@pdf-to-xrechnung/contracts/review-input';

const emptyAnnotations: FieldAnnotations = {
  findings: new Map(),
  issues: new Map(),
  changedPaths: new Set(),
};

function renderSection(locale: 'de' | 'en') {
  return render(
    <DictionaryProvider locale={locale}>
      <LineItemsSection
        lineItems={[{ ...emptyDraftLineItem(), unit: 'Std.' }]}
        onChange={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        annotations={emptyAnnotations}
        disabled={false}
      />
    </DictionaryProvider>,
  );
}

describe('LineItemsSection unit options', () => {
  it('shows German unit option labels in the German locale', () => {
    renderSection('de');
    expect(screen.getByRole('option', { name: 'Stunde' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Stück' })).toBeDefined();
  });

  it('shows English unit option labels in the English locale', () => {
    renderSection('en');
    expect(screen.getByRole('option', { name: 'Hour' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Piece' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Stunde' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Stück' })).toBeNull();
  });

  it('keeps the same option values across locales', () => {
    const de = renderSection('de');
    const deValues = de
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== '');
    de.unmount();

    const en = renderSection('en');
    const enValues = en
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value !== '');
    en.unmount();

    expect(new Set(enValues)).toEqual(new Set(deValues));
  });
});

describe('LineItemsSection field wiring', () => {
  it('shows the value from the draft and forwards an edit with the index and field key', () => {
    const onChange = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <LineItemsSection
          lineItems={[{ ...emptyDraftLineItem(), description: 'Beratung' }]}
          onChange={onChange}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Bezeichnung');
    expect((input as HTMLInputElement).value).toBe('Beratung');

    fireEvent.change(input, { target: { value: 'Konzeption' } });
    expect(onChange).toHaveBeenCalledWith(0, 'description', 'Konzeption');
  });

  it('renders a finding on the field, bound by aria-describedby', () => {
    const finding: InvoiceFinding = {
      rule: 'test.marker_rule',
      field: 'lineItems[0].description',
      severity: 'ERROR',
      passed: false,
      message: 'MARKER: line item description finding',
      expected: null,
      actual: null,
    };
    render(
      <DictionaryProvider locale="de">
        <LineItemsSection
          lineItems={[emptyDraftLineItem()]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={{
            findings: new Map([['lineItems[0].description', [finding]]]),
            issues: new Map(),
            changedPaths: new Set(),
          }}
          disabled={false}
        />
      </DictionaryProvider>,
    );

    const input = screen.getByLabelText('Bezeichnung');
    expect(input.getAttribute('aria-describedby')).toBe(
      fieldMessageId('lineItems[0].description'),
    );
    expect(
      screen.getByText(/MARKER: line item description finding/),
    ).toBeTruthy();
  });

  it('propagates disabled to its fields and the remove/add buttons', () => {
    render(
      <DictionaryProvider locale="de">
        <LineItemsSection
          lineItems={[emptyDraftLineItem()]}
          onChange={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          annotations={emptyAnnotations}
          disabled={true}
        />
      </DictionaryProvider>,
    );

    const description = screen.getByLabelText('Bezeichnung');
    expect(
      description instanceof HTMLInputElement && description.disabled,
    ).toBe(true);
    expect(
      screen
        .getAllByRole('button')
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
  });

  it('disables the add path at the shared maximum', () => {
    expect(lineItemLimitReached(MAX_LINE_ITEMS - 1)).toBe(false);
    expect(lineItemLimitReached(MAX_LINE_ITEMS)).toBe(true);
  });
});
