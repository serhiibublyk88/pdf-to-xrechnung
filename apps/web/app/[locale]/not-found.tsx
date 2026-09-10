'use client';

import Link from 'next/link';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';

export default function LocaleNotFound() {
  const dictionary = useDictionary();
  const locale = useLocale();

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <p className="mb-6 text-text-muted">{dictionary.errors.notFound}</p>
      <Link
        href={`/${locale}`}
        className="rounded-md border border-border px-4 py-2 text-sm text-text hover:bg-surface-raised"
      >
        {dictionary.review.backToList}
      </Link>
    </div>
  );
}
