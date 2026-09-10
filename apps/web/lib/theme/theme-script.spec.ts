import { describe, expect, it } from 'vitest';
import { resolveTheme } from './theme-script';

describe('resolveTheme', () => {
  it('resolves an explicit light attribute to light', () => {
    expect(resolveTheme('light')).toBe('light');
  });

  it('defaults to dark when the attribute is dark', () => {
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('defaults to dark when the attribute is absent', () => {
    expect(resolveTheme(null)).toBe('dark');
  });

  it('defaults to dark for an unrecognised value', () => {
    expect(resolveTheme('sepia')).toBe('dark');
  });
});
