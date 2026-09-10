import './globals.css';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';
import { ThemeInitScript } from '@/lib/theme/theme-init-script';

export const metadata: Metadata = {
  title: 'PDF zu XRechnung',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const locale = requestHeaders.get('x-pdf-to-xrechnung-locale');
  return (
    <html
      lang={locale && isLocale(locale) ? locale : defaultLocale}
      data-theme="dark"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <ThemeInitScript nonce={requestHeaders.get('x-nonce') ?? undefined} />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">
        {children}
      </body>
    </html>
  );
}
