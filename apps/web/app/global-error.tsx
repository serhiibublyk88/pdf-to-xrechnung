'use client';

import './globals.css';
import Link from 'next/link';

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-screen bg-bg text-text antialiased">
        <main className="mx-auto max-w-2xl px-6 py-16 text-center">
          <h1 className="mb-2 text-xl font-semibold">
            Something went wrong. · Etwas ist schiefgelaufen.
          </h1>
          <p className="mb-6 text-text-muted">
            Please try again or return to the invoice list. · Bitte versuchen
            Sie es erneut oder kehren Sie zur Rechnungsliste zurück.
          </p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-accent-bg px-4 py-2 text-sm font-medium text-accent-text hover:opacity-90"
            >
              Try again · Erneut versuchen
            </button>
            <Link
              href="/de"
              className="rounded-md border border-border px-4 py-2 text-sm text-text hover:bg-surface-raised"
            >
              Back to invoices · Zur Rechnungsliste
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
