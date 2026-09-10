import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MAX_TEXT_LENGTH } from '@pdf-to-xrechnung/contracts/review-input';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { Field, localizedEcho } from './field';

describe('localizedEcho', () => {
  it('echoes all significant digits of a long exact decimal without float rounding', () => {
    expect(localizedEcho('0.111111111111111111', 'de')).toBe(
      '0,111111111111111111',
    );
  });

  it('does not throw on a fraction longer than Intl.NumberFormat allows', () => {
    const value = `0.${'1'.repeat(120)}`;

    expect(() => localizedEcho(value, 'de')).not.toThrow();
    expect(typeof localizedEcho(value, 'de')).toBe('string');
  });

  it('returns null for a value that already reads the same formatted', () => {
    expect(localizedEcho('19', 'de')).toBeNull();
  });

  it('returns null for a non-canonical or missing value', () => {
    expect(localizedEcho(null, 'de')).toBeNull();
    expect(localizedEcho('1,5', 'de')).toBeNull();
  });
});

describe('Field', () => {
  it('bounds free text to the shared contract limit', () => {
    render(
      <DictionaryProvider locale="en">
        <Field
          path="invoiceNumber"
          label="Invoice number"
          value={null}
          onChange={() => {}}
        />
      </DictionaryProvider>,
    );

    expect(
      screen.getByLabelText('Invoice number').getAttribute('maxLength'),
    ).toBe(String(MAX_TEXT_LENGTH));
  });
});
