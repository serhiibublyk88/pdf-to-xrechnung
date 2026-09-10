import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeToggle } from './theme-toggle';
import { THEME_STORAGE_KEY } from './theme-script';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.clear();
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('offers the theme it is not currently in, not the current one', () => {
    render(
      <ThemeToggle darkLabel="Dunkles Design" lightLabel="Helles Design" />,
    );

    expect(screen.getByRole('button', { name: 'Helles Design' })).toBeTruthy();
  });

  it('switches the DOM attribute and persists the choice on click', async () => {
    render(
      <ThemeToggle darkLabel="Dunkles Design" lightLabel="Helles Design" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Helles Design' }));

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('light'),
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('switches the DOM attribute when localStorage rejects the write', async () => {
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException(
        'The quota has been exceeded.',
        'QuotaExceededError',
      );
    });
    render(
      <ThemeToggle darkLabel="Dunkles Design" lightLabel="Helles Design" />,
    );

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Helles Design' }));
      await waitFor(() =>
        expect(document.documentElement.getAttribute('data-theme')).toBe(
          'light',
        ),
      );
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it('uses its accessible name only for the theme-switch action', async () => {
    render(
      <ThemeToggle darkLabel="Dunkles Design" lightLabel="Helles Design" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Helles Design' }));

    const darkButton = await screen.findByRole('button', {
      name: 'Dunkles Design',
    });
    expect(darkButton.getAttribute('aria-pressed')).toBeNull();
  });

  it('toggles back to dark on a second click', async () => {
    render(
      <ThemeToggle darkLabel="Dunkles Design" lightLabel="Helles Design" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Helles Design' }));
    const darkButton = await screen.findByRole('button', {
      name: 'Dunkles Design',
    });
    fireEvent.click(darkButton);

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
