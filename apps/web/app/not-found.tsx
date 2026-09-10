import Link from 'next/link';
import { ThemeSyncEffect } from '@/lib/theme/theme-sync-effect';

export default function RootNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg text-center text-text">
      <ThemeSyncEffect />
      <p className="text-text-muted">
        Diese Seite existiert nicht. · This page does not exist.
      </p>
      <Link href="/de" className="text-text">
        PDF zu XRechnung
      </Link>
    </div>
  );
}
