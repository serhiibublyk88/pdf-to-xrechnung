import { ibanHasValidChecksum, vatIdHasValidChecksum } from './checksums';

describe('vatIdHasValidChecksum', () => {
  it.each(['DE136695976', 'DE811907980', 'DE129273398'])(
    'accepts the known-valid German VAT ID %s',
    (vatId) => {
      expect(vatIdHasValidChecksum(vatId)).toBe(true);
    },
  );

  it('rejects a German VAT ID with a mutated check digit', () => {
    expect(vatIdHasValidChecksum('DE136695977')).toBe(false);
  });

  it('rejects a non-German VAT ID shape outright', () => {
    expect(vatIdHasValidChecksum('FR12345678901')).toBe(false);
  });

  it('accepts a lowercase German VAT ID', () => {
    expect(vatIdHasValidChecksum('de136695976')).toBe(true);
  });

  it('accepts a German VAT ID with the spaces it is printed with', () => {
    expect(vatIdHasValidChecksum('DE 136 695 976')).toBe(true);
  });
});

describe('ibanHasValidChecksum', () => {
  it('accepts a known-valid IBAN with no spaces', () => {
    expect(ibanHasValidChecksum('DE89370400440532013000')).toBe(true);
  });

  it('accepts an IBAN with the spaces it is printed with', () => {
    expect(ibanHasValidChecksum('DE89 3704 0044 0532 0130 00')).toBe(true);
  });

  it('rejects a mutated checksum', () => {
    expect(ibanHasValidChecksum('DE89370400440532013001')).toBe(false);
  });

  it('rejects a German IBAN with the wrong length', () => {
    expect(ibanHasValidChecksum('DE8937040044053201300')).toBe(false);
  });

  // Independent MOD-97 helper (ISO 7064), not a copy of the production streaming loop.
  function checksumValidIban(countryCode: string, bban: string): string {
    const numeric = (value: string) =>
      value
        .split('')
        .map((character) =>
          /\d/.test(character)
            ? character
            : String(character.charCodeAt(0) - 55),
        )
        .join('');
    const remainder = BigInt(numeric(`${bban}${countryCode}00`)) % 97n;
    const checkDigits = (98n - remainder).toString().padStart(2, '0');
    return `${countryCode}${checkDigits}${bban}`;
  }

  it('accepts a checksum-valid generic IBAN at the 15-character lower bound', () => {
    const iban = checksumValidIban('XX', 'ABCD1234567');
    expect(iban).toHaveLength(15);
    expect(ibanHasValidChecksum(iban)).toBe(true);
  });

  it('accepts a checksum-valid generic IBAN at the 34-character upper bound', () => {
    const iban = checksumValidIban('XX', 'A1B2'.repeat(8).slice(0, 30));
    expect(iban).toHaveLength(34);
    expect(ibanHasValidChecksum(iban)).toBe(true);
  });

  it('rejects a checksum-valid generic IBAN one character below the lower bound', () => {
    const iban = checksumValidIban('XX', 'ABCD123456');
    expect(iban).toHaveLength(14);
    expect(ibanHasValidChecksum(iban)).toBe(false);
  });

  it('rejects a checksum-valid generic IBAN one character above the upper bound', () => {
    const iban = checksumValidIban('XX', 'A1B2'.repeat(8).slice(0, 31));
    expect(iban).toHaveLength(35);
    expect(ibanHasValidChecksum(iban)).toBe(false);
  });

  it('rejects a checksum-valid DE IBAN that is not exactly 22 characters', () => {
    const iban = checksumValidIban('DE', 'ABCD1234567890A');
    expect(iban).toHaveLength(19);
    expect(ibanHasValidChecksum(iban)).toBe(false);
  });

  it('accepts a checksum-valid generic IBAN printed lowercase with spaces', () => {
    const iban = checksumValidIban('XX', 'ABCD1234567');
    const printed = iban
      .toLowerCase()
      .match(/.{1,4}/g)!
      .join(' ');
    expect(ibanHasValidChecksum(printed)).toBe(true);
  });
});
