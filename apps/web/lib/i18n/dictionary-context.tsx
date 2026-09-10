'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getDictionary, type Dictionary } from './dictionary';
import { isLocale, type Locale } from './locales';

const DictionaryContext = createContext<{
  dictionary: Dictionary;
  locale: Locale;
  switchLocale: (locale: Locale, pathname: string) => void;
} | null>(null);

// Dictionaries contain functions, which cannot cross the Server to Client prop boundary.
export function DictionaryProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const dictionary = useMemo(() => getDictionary(activeLocale), [activeLocale]);
  useEffect(() => {
    function syncLocaleFromHistory() {
      const candidate = window.location.pathname.split('/')[1] ?? '';
      if (isLocale(candidate)) setActiveLocale(candidate);
    }

    window.addEventListener('popstate', syncLocaleFromHistory);
    return () => {
      window.removeEventListener('popstate', syncLocaleFromHistory);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = activeLocale;
    document.title = dictionary.app.title;
    const description = document.head.querySelector('meta[name="description"]');
    if (description)
      description.setAttribute('content', dictionary.app.description);
  }, [activeLocale, dictionary]);

  function switchLocale(nextLocale: Locale, pathname: string): void {
    window.history.pushState(null, '', pathname);
    setActiveLocale(nextLocale);
  }

  return (
    <DictionaryContext.Provider
      value={{ dictionary, locale: activeLocale, switchLocale }}
    >
      {children}
    </DictionaryContext.Provider>
  );
}

export function useDictionary(): Dictionary {
  const context = useContext(DictionaryContext);
  if (!context) {
    throw new Error('useDictionary must be used within a DictionaryProvider');
  }
  return context.dictionary;
}

export function useLocale(): Locale {
  const context = useContext(DictionaryContext);
  if (!context) {
    throw new Error('useLocale must be used within a DictionaryProvider');
  }
  return context.locale;
}

export function useSwitchLocale(): (locale: Locale, pathname: string) => void {
  const context = useContext(DictionaryContext);
  if (!context) {
    throw new Error('useSwitchLocale must be used within a DictionaryProvider');
  }
  return context.switchLocale;
}
