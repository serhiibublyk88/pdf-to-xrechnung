import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeSyncEffect } from './theme-sync-effect';
import { THEME_STORAGE_KEY } from './theme-script';

describe('ThemeSyncEffect', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('applies a stored light preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    render(<ThemeSyncEffect />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies a stored dark preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<ThemeSyncEffect />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the attribute untouched when no preference is stored', () => {
    render(<ThemeSyncEffect />);

    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('leaves the attribute untouched for a stored value that is neither theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');

    render(<ThemeSyncEffect />);

    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('renders nothing visible', () => {
    const { container } = render(<ThemeSyncEffect />);

    expect(container.firstChild).toBeNull();
  });
});
