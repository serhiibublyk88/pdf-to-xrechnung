'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useDictionary,
  useLocale,
  useSwitchLocale,
} from '@/lib/i18n/dictionary-context';
import { locales } from '@/lib/i18n/locales';
import { ThemeToggle } from '@/lib/theme/theme-toggle';

function withLocale(pathname: string, targetLocale: string): string {
  const segments = pathname.split('/');
  segments[1] = targetLocale;
  return segments.join('/') || `/${targetLocale}`;
}

export function AppHeader() {
  const dictionary = useDictionary();
  const locale = useLocale();
  const switchLocale = useSwitchLocale();
  const pathname = usePathname();

  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-3">
      <Link href={`/${locale}`} className="font-semibold text-text">
        {dictionary.app.title}
      </Link>
      <div className="flex items-center gap-2">
        {/* Each half stays a real link, so the locale is shareable and crawlable. */}
        <nav
          aria-label={dictionary.locale.switchLabel}
          className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
        >
          {locales.map((candidate) => {
            const isCurrent = candidate === locale;
            return (
              <Link
                key={candidate}
                href={withLocale(pathname, candidate)}
                hrefLang={candidate}
                prefetch={false}
                aria-current={isCurrent ? 'true' : undefined}
                title={dictionary.locale[candidate]}
                onClick={(event) => {
                  // Route navigation would discard an in-progress correction draft.
                  event.preventDefault();
                  switchLocale(candidate, withLocale(pathname, candidate));
                }}
                className={`rounded px-2 py-1 text-xs font-medium uppercase transition-colors ${
                  isCurrent
                    ? 'bg-surface-raised text-text shadow-sm'
                    : 'text-text-muted hover:text-text'
                }`}
              >
                {candidate}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle
          darkLabel={dictionary.theme.switchToDark}
          lightLabel={dictionary.theme.switchToLight}
        />
      </div>
    </header>
  );
}
