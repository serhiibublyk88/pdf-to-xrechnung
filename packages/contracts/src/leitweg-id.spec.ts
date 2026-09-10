import { leitwegIdHasValidChecksum, looksLikeLeitwegId } from './leitweg-id';

describe('leitwegIdHasValidChecksum', () => {
  // Worked example from KoSIT's own format specification v2.0.2 §2.4.
  it("accepts the KoSIT specification's own worked example", () => {
    expect(leitwegIdHasValidChecksum('04011000-1234512345-06')).toBe(true);
  });

  it('accepts a Leitweg-ID with no Feinadressierung', () => {
    expect(leitwegIdHasValidChecksum('9930-87')).toBe(true);
  });

  it('accepts a Feinadressierung containing letters, case-insensitively', () => {
    expect(leitwegIdHasValidChecksum('04011000-AB123-62')).toBe(true);
    expect(leitwegIdHasValidChecksum('04011000-ab123-62')).toBe(true);
  });

  it('rejects a mutated check digit', () => {
    expect(leitwegIdHasValidChecksum('04011000-1234512345-07')).toBe(false);
  });

  it('rejects a value with no check-digit segment', () => {
    expect(leitwegIdHasValidChecksum('04011000-1234512345')).toBe(false);
  });

  it('rejects a value that is not shaped like a Leitweg-ID at all', () => {
    expect(leitwegIdHasValidChecksum('PO-2024-00381')).toBe(false);
  });

  // Independent MOD-97 helper (ISO 7064), not a copy of the production character loop.
  function checksumValidLeitwegId(coarse: string, fine = ''): string {
    const digitsOnly = `${coarse}${fine}`
      .toUpperCase()
      .split('')
      .map((character) =>
        /\d/.test(character) ? character : String(character.charCodeAt(0) - 55),
      )
      .join('');
    const remainder = BigInt(`${digitsOnly}00`) % 97n;
    const checkDigits = (98n - remainder).toString().padStart(2, '0');
    return fine
      ? `${coarse}-${fine}-${checkDigits}`
      : `${coarse}-${checkDigits}`;
  }

  it('accepts the coarse 2-digit lower bound with no Feinadressierung', () => {
    expect(leitwegIdHasValidChecksum(checksumValidLeitwegId('12'))).toBe(true);
  });

  it('accepts the coarse 12-digit upper bound with no Feinadressierung', () => {
    expect(
      leitwegIdHasValidChecksum(checksumValidLeitwegId('123456789012')),
    ).toBe(true);
  });

  it('accepts the fine 1-character lower bound', () => {
    expect(leitwegIdHasValidChecksum(checksumValidLeitwegId('1234', 'A'))).toBe(
      true,
    );
  });

  it('accepts the fine 30-character upper bound', () => {
    expect(
      leitwegIdHasValidChecksum(checksumValidLeitwegId('1234', 'A'.repeat(30))),
    ).toBe(true);
  });

  it('rejects a checksum-valid coarse segment one digit below the lower bound', () => {
    expect(leitwegIdHasValidChecksum(checksumValidLeitwegId('1'))).toBe(false);
  });

  it('rejects a checksum-valid coarse segment one digit above the upper bound', () => {
    expect(
      leitwegIdHasValidChecksum(checksumValidLeitwegId('1234567890123')),
    ).toBe(false);
  });

  it('rejects a fine segment one character above the upper bound', () => {
    const oversized = checksumValidLeitwegId('1234', 'A'.repeat(31));
    expect(leitwegIdHasValidChecksum(oversized)).toBe(false);
  });

  it('rejects a value with a double hyphen instead of one separator', () => {
    expect(leitwegIdHasValidChecksum('04011000--1234512345-06')).toBe(false);
  });

  it('rejects a value missing the separator before the check digits', () => {
    expect(leitwegIdHasValidChecksum('0401100087')).toBe(false);
  });

  it('rejects non-ASCII characters in the Feinadressierung', () => {
    expect(leitwegIdHasValidChecksum('04011000-Straße-06')).toBe(false);
  });

  it('rejects non-alphanumeric characters in the Feinadressierung', () => {
    expect(leitwegIdHasValidChecksum('04011000-AB_123-06')).toBe(false);
  });
});

describe('looksLikeLeitwegId', () => {
  it('accepts the shape regardless of checksum validity', () => {
    expect(looksLikeLeitwegId('04011000-1234512345-99')).toBe(true);
  });

  it('rejects an ordinary purchase-order reference', () => {
    expect(looksLikeLeitwegId('PO-2024-00381')).toBe(false);
  });
});
