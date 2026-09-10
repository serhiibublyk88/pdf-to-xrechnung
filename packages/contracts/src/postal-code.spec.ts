import { isGermanPostalCode } from './postal-code';

describe('isGermanPostalCode', () => {
  it('accepts a five-digit code', () => {
    expect(isGermanPostalCode('10115')).toBe(true);
  });

  it('rejects fewer than five digits', () => {
    expect(isGermanPostalCode('1234')).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isGermanPostalCode('1011A')).toBe(false);
  });

  it('accepts a five-digit code with a leading zero', () => {
    expect(isGermanPostalCode('01067')).toBe(true);
  });

  it('rejects six digits', () => {
    expect(isGermanPostalCode('101150')).toBe(false);
  });

  it('rejects surrounding whitespace', () => {
    expect(isGermanPostalCode(' 10115 ')).toBe(false);
  });

  it('rejects a non-ASCII digit', () => {
    expect(isGermanPostalCode('1011٥')).toBe(false);
  });
});
