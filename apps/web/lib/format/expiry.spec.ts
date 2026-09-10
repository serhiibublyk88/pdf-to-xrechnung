import { describe, expect, it } from 'vitest';
import { formatRemainingCompact, formatRemainingTime } from './expiry';
import { de } from '../i18n/de';

const now = new Date('2026-08-12T12:00:00.000Z');

describe('formatRemainingTime', () => {
  it('reports expired for a timestamp in the past', () => {
    expect(formatRemainingTime('2026-08-12T11:59:59.000Z', now, de)).toBe(
      de.upload.expiredNotice,
    );
  });

  it('reports minutes remaining under one hour', () => {
    expect(formatRemainingTime('2026-08-12T12:30:00.000Z', now, de)).toBe(
      de.upload.expiresInMinutes(30),
    );
  });

  it('rounds up partial minutes so it never undercounts', () => {
    expect(formatRemainingTime('2026-08-12T12:00:30.000Z', now, de)).toBe(
      de.upload.expiresInMinutes(1),
    );
  });

  it('reports whole hours without a minutes part', () => {
    expect(formatRemainingTime('2026-08-12T14:00:00.000Z', now, de)).toBe(
      de.upload.expiresInHours(2),
    );
  });

  it('does not round 61 minutes up to two hours', () => {
    expect(formatRemainingTime('2026-08-12T13:01:00.000Z', now, de)).toBe(
      de.upload.expiresInHoursMinutes(1, 1),
    );
  });

  it('reports hours and minutes for a partial hour', () => {
    expect(formatRemainingTime('2026-08-12T13:47:00.000Z', now, de)).toBe(
      de.upload.expiresInHoursMinutes(1, 47),
    );
  });
});

describe('formatRemainingCompact', () => {
  it('reports a short marker, not a sentence, for a timestamp in the past', () => {
    expect(formatRemainingCompact('2026-08-12T11:59:59.000Z', now)).toBe(
      '0:00',
    );
  });

  it('pads minutes under an hour to two digits with a zero hour', () => {
    expect(formatRemainingCompact('2026-08-12T12:07:00.000Z', now)).toBe(
      '0:07',
    );
  });

  it('formats whole hours as :00', () => {
    expect(formatRemainingCompact('2026-08-12T14:00:00.000Z', now)).toBe(
      '2:00',
    );
  });

  it('formats hours and minutes together', () => {
    expect(formatRemainingCompact('2026-08-12T13:47:00.000Z', now)).toBe(
      '1:47',
    );
  });
});
