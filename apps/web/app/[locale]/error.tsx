'use client';
import { useDictionary, useLocale } from '@/lib/i18n/dictionary-context';

export default function LocaleError({ reset }: { reset: () => void }) {
  const dictionary = useDictionary();
  const locale = useLocale();

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="mb-2 text-xl font-semibold text-text">
        {dictionary.errors.genericTitle}
      </h1>
      <p className="mb-6 text-text-muted">{dictionary.errors.genericBody}</p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-accent-bg px-4 py-2 text-sm font-medium text-accent-text hover:opacity-90"
        >
          {dictionary.common.retry}
        </button>
        <a
          href={`/${locale}`}
          className="rounded-md border border-border px-4 py-2 text-sm text-text hover:bg-surface-raised"
        >
          {dictionary.review.backToList}
        </a>
      </div>
    </div>
  );
}
