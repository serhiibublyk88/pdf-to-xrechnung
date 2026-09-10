import {
  CURRENCY_CODES,
  REJECTED_BY_KOSIT_CURRENCY_CODES,
  SUPPORTED_CURRENCY_CODES,
} from './currencies';

describe('currency codes', () => {
  it('includes EUR and excludes the KoSIT-rejected STN', () => {
    expect(CURRENCY_CODES).toContain('EUR');
    expect(SUPPORTED_CURRENCY_CODES.has('STN')).toBe(false);
    expect(REJECTED_BY_KOSIT_CURRENCY_CODES).toEqual(['STN']);
  });
});
