import { vatIdHasAllowedPrefix, vatIdHasValidSyntax } from './vat-id';

describe('VAT ID helpers', () => {
  it.each(['DE136695976', 'EL123456789', 'XI123456789', '1A123456789'])(
    'accepts the KoSIT-supported VAT-ID prefix %s',
    (vatId) => {
      expect(vatIdHasAllowedPrefix(vatId)).toBe(true);
    },
  );

  it('rejects a prefix outside the KoSIT list', () => {
    expect(vatIdHasAllowedPrefix('XX123456789')).toBe(false);
  });

  it.each([
    ['DE136695976', true],
    ['DE 136 695 976', true],
    ['XX123456789', true],
    ['DE', false],
    ['DE-123', false],
  ])('checks basic syntax for %s', (vatId, expected) => {
    expect(vatIdHasValidSyntax(vatId)).toBe(expected);
  });
});
