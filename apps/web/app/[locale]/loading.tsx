'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';

export default function LocaleLoading() {
  const dictionary = useDictionary();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8" role="status" aria-busy="true">
      <span className="sr-only">{dictionary.common.loading}</span>
      <div className="h-7 w-56 animate-pulse rounded bg-surface-raised" />
      <div className="mt-4 h-40 animate-pulse rounded-lg bg-surface-raised" />
      <div className="mt-8 h-6 w-40 animate-pulse rounded bg-surface-raised" />
      <div className="mt-3 flex flex-col gap-3">
        <div className="h-14 animate-pulse rounded bg-surface-raised" />
        <div className="h-14 animate-pulse rounded bg-surface-raised" />
      </div>
    </div>
  );
}
