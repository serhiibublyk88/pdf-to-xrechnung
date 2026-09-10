import { COUNTRY_CODES, SUPPORTED_COUNTRY_CODES } from './country-codes';

describe('country codes', () => {
  it('includes the XRechnung-specific 1A and XI codes', () => {
    expect(COUNTRY_CODES).toEqual(expect.arrayContaining(['DE', '1A', 'XI']));
    expect(SUPPORTED_COUNTRY_CODES.has('UK')).toBe(false);
  });
});
