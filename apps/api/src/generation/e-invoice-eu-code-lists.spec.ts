import { invoiceSchema } from '@e-invoice-eu/core';
import {
  COUNTRY_CODES,
  CURRENCY_CODES,
  IMPLIED_VAT_EXEMPTION_REASON_CODES,
  REJECTED_BY_KOSIT_CURRENCY_CODES,
  SUPPORTED_CURRENCY_CODES,
  VAT_CATEGORY_CODES,
} from '@pdf-to-xrechnung/contracts';
import { SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES } from './e-invoice-eu-code-lists';

function codesFromSchema(
  listName: 'ISO4217' | 'ISO3166' | 'UNCL5305' | 'vatex',
): string[] {
  const definitions: unknown = invoiceSchema.$defs;
  if (!asRecord(definitions)) {
    throw new Error('invoiceSchema definitions are not an object');
  }
  const codeLists = definitions.codeLists;
  if (!asRecord(codeLists)) {
    throw new Error('invoiceSchema code lists are not an object');
  }
  const codeList = codeLists[listName];
  if (!asRecord(codeList)) {
    throw new Error(`invoiceSchema code list ${listName} is not an object`);
  }
  const values = codeList.enum;
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === 'string')
  ) {
    throw new Error(`invoiceSchema code list ${listName} is not a string enum`);
  }
  return values;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectSameCodes(
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((code) => !actualSet.has(code));
  const unexpected = [...actualSet].filter((code) => !expectedSet.has(code));
  expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
}

describe('e-invoice-eu-code-lists', () => {
  it('recognizes a known currency code', () => {
    expect(SUPPORTED_CURRENCY_CODES.has('EUR')).toBe(true);
  });

  it('excludes STN, which the pinned KoSIT target rejects under BR-CL-04', () => {
    expect(SUPPORTED_CURRENCY_CODES.has('STN')).toBe(false);
  });

  it('matches the library currency list except for the KoSIT rejection', () => {
    const rejected = new Set<string>(REJECTED_BY_KOSIT_CURRENCY_CODES);
    expectSameCodes(
      CURRENCY_CODES,
      codesFromSchema('ISO4217').filter((code) => !rejected.has(code)),
    );
  });

  it('matches the library country list', () => {
    expectSameCodes(COUNTRY_CODES, codesFromSchema('ISO3166'));
  });

  it('recognizes a known electronic address scheme', () => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has('EM')).toBe(true);
  });

  it('excludes 0245, which the pinned KoSIT target rejects under BR-CL-25', () => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has('0245')).toBe(false);
  });

  it('offers only VAT category codes the library UNCL5305 list accepts', () => {
    const libraryCodes = new Set(codesFromSchema('UNCL5305'));
    for (const code of VAT_CATEGORY_CODES) {
      expect(libraryCodes.has(code)).toBe(true);
    }
  });

  it('deliberately does not offer the Canary Islands/Ceuta-Melilla/split-payment codes', () => {
    for (const code of ['L', 'M', 'B']) {
      expect(VAT_CATEGORY_CODES).not.toContain(code);
    }
  });

  it('resolves every implied exemption reason to a real vatex code', () => {
    const libraryCodes = new Set(codesFromSchema('vatex'));
    for (const code of Object.values(IMPLIED_VAT_EXEMPTION_REASON_CODES)) {
      expect(libraryCodes.has(code)).toBe(true);
    }
  });
});
