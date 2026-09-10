import {
  ELECTRONIC_ADDRESS_SCHEMES,
  SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES,
} from './electronic-address-schemes';

describe('electronic address schemes', () => {
  it('has the same number of entries in the array and the set (no duplicates)', () => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.size).toBe(
      ELECTRONIC_ADDRESS_SCHEMES.length,
    );
  });

  it.each(['0204', '9930', 'EM'])('recognizes known scheme %s', (scheme) => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has(scheme)).toBe(true);
  });

  it('does not recognize an arbitrary unknown scheme', () => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has('ZZZZ')).toBe(false);
  });

  it('excludes 0245, which the pinned KoSIT target rejects under BR-CL-25', () => {
    expect(SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has('0245')).toBe(false);
  });

  it('has exactly 97 entries — the current generator/KoSIT intersection', () => {
    expect(ELECTRONIC_ADDRESS_SCHEMES).toHaveLength(97);
  });
});
