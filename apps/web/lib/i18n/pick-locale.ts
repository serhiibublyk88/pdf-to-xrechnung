import { defaultLocale, locales } from './locales';

function qualityOf(entry: string): number {
  const match = entry.match(/;q=([\d.]+)/);
  const quality = match ? Number(match[1]) : 1;
  return Number.isFinite(quality) ? quality : 1;
}

export function pickLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return defaultLocale;

  const ranked = acceptLanguage
    .split(',')
    .map((entry) => ({
      lang: entry.split(';')[0]?.trim().toLowerCase().slice(0, 2),
      quality: qualityOf(entry),
    }))
    .sort((a, b) => b.quality - a.quality);

  for (const { lang } of ranked) {
    const supported = locales.find((locale) => locale === lang);
    if (supported) return supported;
  }
  return defaultLocale;
}
