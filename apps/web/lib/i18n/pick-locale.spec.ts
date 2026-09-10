import { describe, expect, it } from 'vitest';
import { pickLocale } from './pick-locale';

describe('pickLocale', () => {
  it('falls back to the default locale when there is no header', () => {
    expect(pickLocale(null)).toBe('de');
  });

  it('picks the supported language even when it is not first in the list', () => {
    expect(pickLocale('fr-FR,en;q=0.9,de;q=0.8')).toBe('en');
  });

  it('picks by quality weight, not by position', () => {
    expect(pickLocale('en;q=0.1,de;q=0.9')).toBe('de');
  });

  it('falls back to the default locale when no language in the list is supported', () => {
    expect(pickLocale('fr-FR,es;q=0.9')).toBe('de');
  });
});
