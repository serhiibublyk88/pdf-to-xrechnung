'use client';

import { useDictionary } from '@/lib/i18n/dictionary-context';
import { invoiceSourceUrl } from '@/lib/api/urls';

const VIEWER_PARAMS = '#toolbar=0&navpanes=0&view=FitH';

export function PdfPanel({ invoiceId }: { invoiceId: string }) {
  const dictionary = useDictionary();
  const sourceUrl = invoiceSourceUrl(invoiceId);

  return (
    <div className="flex h-full flex-col gap-2">
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start text-sm text-text-muted underline-offset-2 hover:underline"
      >
        {dictionary.common.openInNewTab}
      </a>
      <iframe
        src={`${sourceUrl}${VIEWER_PARAMS}`}
        title={dictionary.review.sourceTitle}
        className="h-[70vh] w-full rounded-md border border-border bg-surface lg:h-[calc(100vh-9rem)]"
      />
    </div>
  );
}
