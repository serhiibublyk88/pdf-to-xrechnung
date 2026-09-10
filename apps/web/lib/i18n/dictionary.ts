import { de } from './de';
import { en } from './en';
import type { Locale } from './locales';

export type Dictionary = typeof de;

const dictionaries: Record<Locale, Dictionary> = { de, en };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
