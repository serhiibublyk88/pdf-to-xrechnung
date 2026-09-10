import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import LocaleError from './error';

describe('LocaleError', () => {
  it('renders the dictionary error copy and calls reset on click', () => {
    const reset = vi.fn();
    render(
      <DictionaryProvider locale="de">
        <LocaleError reset={reset} />
      </DictionaryProvider>,
    );

    expect(
      screen.getByRole('heading', { name: 'Etwas ist schiefgelaufen' }),
    ).toBeTruthy();
    expect(screen.getByText('Bitte erneut versuchen.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('links back to the active locale, not a hardcoded one', () => {
    render(
      <DictionaryProvider locale="en">
        <LocaleError reset={() => {}} />
      </DictionaryProvider>,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/en');
  });
});
