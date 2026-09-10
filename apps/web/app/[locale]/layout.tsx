import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDictionary } from '@/lib/i18n/dictionary';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';
import { AppHeader } from '@/components/app-header';
import { DemoModeNotice } from '@/components/demo-mode-notice';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const dictionary = getDictionary(locale);
  return {
    title: dictionary.app.title,
    description: dictionary.app.description,
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) redirect(`/${defaultLocale}`);

  return (
    <DictionaryProvider locale={locale}>
      <AppHeader />
      <DemoModeNotice />
      <main>{children}</main>
    </DictionaryProvider>
  );
}
