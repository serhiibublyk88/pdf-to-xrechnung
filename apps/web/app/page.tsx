import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { pickLocale } from '@/lib/i18n/pick-locale';

export default async function RootPage() {
  const headersList = await headers();
  redirect(`/${pickLocale(headersList.get('accept-language'))}`);
}
