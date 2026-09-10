import {
  canonicalDecimalKey,
  parseDecimalString,
  percentageOfInMinorUnits,
  productInMinorUnits,
  toMinorUnits,
} from './decimal';

describe('parseDecimalString', () => {
  it('parses an integer with no fraction', () => {
    expect(parseDecimalString('19')).toEqual({ coefficient: 19n, scale: 0 });
  });

  it('parses a negative fraction', () => {
    expect(parseDecimalString('-30.33')).toEqual({
      coefficient: -3033n,
      scale: 2,
    });
  });

  it('rejects a value with more than one decimal point', () => {
    expect(() => parseDecimalString('1.2.3')).toThrow('Invalid decimal');
  });

  it('rejects a locale-formatted value', () => {
    expect(() => parseDecimalString('1.234,56')).toThrow('Invalid decimal');
  });

  it('parses a coefficient far above Number.MAX_SAFE_INTEGER exactly', () => {
    expect(parseDecimalString('9007199254740993.01')).toEqual({
      coefficient: 900719925474099301n,
      scale: 2,
    });
  });

  it.each(['01', '00.10', '-01.0'])(
    'rejects the leading-zero spelling %s the shared canonical pattern also rejects',
    (value) => {
      expect(() => parseDecimalString(value)).toThrow('Invalid decimal');
    },
  );

  it.each(['.5', '1.', '+1', '1e5', ' 1.00', '1.00 '])(
    'rejects the non-canonical spelling %s',
    (value) => {
      expect(() => parseDecimalString(value)).toThrow('Invalid decimal');
    },
  );

  it('throws a generic error that does not carry the raw invalid value', () => {
    expect(() =>
      parseDecimalString('SYNTHETIC_INVOICE_CONTENT_MARKER'),
    ).toThrow('Invalid decimal');
    try {
      parseDecimalString('SYNTHETIC_INVOICE_CONTENT_MARKER');
      throw new Error('expected parseDecimalString to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('SYNTHETIC_INVOICE_CONTENT_MARKER');
    }
  });
});

describe('toMinorUnits', () => {
  it('converts a canonical euro string to cents', () => {
    expect(toMinorUnits('119.00')).toBe(11900n);
  });

  it('pads a lower-scale value with zeros', () => {
    expect(toMinorUnits('19')).toBe(1900n);
  });

  it('rejects a printed monetary amount with more than two decimal places', () => {
    expect(() => toMinorUnits('119.001')).toThrow('exceeding the allowed 2');
  });
});

describe('productInMinorUnits', () => {
  it('matches quantity times unit price for a whole-cent result', () => {
    expect(productInMinorUnits('3', '10.11')).toBe(3033n);
  });

  it('rounds a fractional-cent product half away from zero', () => {
    expect(productInMinorUnits('3', '0.005')).toBe(2n);
  });

  it('rounds a positive value half away from zero', () => {
    expect(productInMinorUnits('1.255', '1')).toBe(126n);
  });

  it('rounds a negative value half away from zero', () => {
    expect(productInMinorUnits('-3', '0.005')).toBe(-2n);
  });

  it('rounds a discarded digit below half toward zero', () => {
    expect(productInMinorUnits('1', '0.124')).toBe(12n);
  });

  it('rounds a discarded digit above half away from zero', () => {
    expect(productInMinorUnits('1', '0.126')).toBe(13n);
  });

  it('mirrors below/above-half rounding for the negative operand', () => {
    expect(productInMinorUnits('-1', '0.124')).toBe(-12n);
    expect(productInMinorUnits('-1', '0.126')).toBe(-13n);
  });

  it('preserves the sign of a negative right operand', () => {
    expect(productInMinorUnits('3', '-10.11')).toBe(-3033n);
  });

  it('cancels the sign of a double-negative product', () => {
    expect(productInMinorUnits('-3', '-10.11')).toBe(3033n);
  });

  it('keeps full operand precision above Number.MAX_SAFE_INTEGER through the exact cent result', () => {
    expect(productInMinorUnits('9007199254740993.01', '2')).toBe(
      1801439850948198602n,
    );
  });
});

describe('percentageOfInMinorUnits', () => {
  it('computes 19% VAT on a clean base', () => {
    expect(percentageOfInMinorUnits('100.00', '19')).toBe(1900n);
  });

  it('computes a mixed-VAT base with rounding', () => {
    expect(percentageOfInMinorUnits('30.33', '7')).toBe(212n);
  });

  it('returns zero for a zero rate', () => {
    expect(percentageOfInMinorUnits('1500.00', '0')).toBe(0n);
  });

  it('preserves a negative base', () => {
    expect(percentageOfInMinorUnits('-100.00', '19')).toBe(-1900n);
  });

  it('preserves a negative rate', () => {
    expect(percentageOfInMinorUnits('100.00', '-19')).toBe(-1900n);
  });

  it('keeps the exact multiplication/division result above Number.MAX_SAFE_INTEGER', () => {
    expect(percentageOfInMinorUnits('9007199254740993.01', '10')).toBe(
      90071992547409930n,
    );
  });
});

describe('canonicalDecimalKey', () => {
  it('treats "19" and "19.00" as the same key', () => {
    expect(canonicalDecimalKey('19')).toBe(canonicalDecimalKey('19.00'));
  });

  it('normalises zero regardless of scale', () => {
    expect(canonicalDecimalKey('0.00')).toBe('0');
    expect(canonicalDecimalKey('0')).toBe('0');
  });

  it('keeps distinct rates distinct', () => {
    expect(canonicalDecimalKey('19')).not.toBe(canonicalDecimalKey('7'));
  });

  it('gives a positive and a negative value with the same magnitude distinct keys', () => {
    expect(canonicalDecimalKey('19')).not.toBe(canonicalDecimalKey('-19'));
  });

  it('canonicalizes a negative trailing-zero spelling without losing the sign', () => {
    expect(canonicalDecimalKey('-19.00')).toBe(canonicalDecimalKey('-19'));
    expect(canonicalDecimalKey('-19')).not.toBe(canonicalDecimalKey('19'));
  });
});
