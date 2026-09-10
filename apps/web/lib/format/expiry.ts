import type { Dictionary } from '../i18n/dictionary';

function remainingParts(
  expiresAt: string,
  now: Date,
): { hours: number; minutes: number } | null {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (remainingMs <= 0) return null;

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export function formatRemainingTime(
  expiresAt: string,
  now: Date,
  dictionary: Dictionary,
): string {
  const parts = remainingParts(expiresAt, now);
  if (!parts) return dictionary.upload.expiredNotice;

  const { hours, minutes } = parts;
  if (hours === 0) return dictionary.upload.expiresInMinutes(minutes);
  return minutes === 0
    ? dictionary.upload.expiresInHours(hours)
    : dictionary.upload.expiresInHoursMinutes(hours, minutes);
}

export function formatRemainingCompact(expiresAt: string, now: Date): string {
  const parts = remainingParts(expiresAt, now);
  if (!parts) return '0:00';

  return `${parts.hours}:${String(parts.minutes).padStart(2, '0')}`;
}
