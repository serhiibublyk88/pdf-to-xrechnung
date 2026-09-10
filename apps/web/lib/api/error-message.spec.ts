import { describe, expect, it } from 'vitest';
import { describeApiError } from './error-message';
import { de } from '@/lib/i18n/de';
import type { ApiError } from './errors';

describe('describeApiError', () => {
  it('maps every ApiError kind to a non-empty, distinct message', () => {
    const errors: ApiError[] = [
      { kind: 'bad_request' },
      { kind: 'unauthorized' },
      { kind: 'not_found' },
      { kind: 'conflict' },
      { kind: 'payload_too_large' },
      { kind: 'rate_limited', retryAfterSeconds: 30 },
      { kind: 'network_error' },
      { kind: 'parse_error' },
      { kind: 'server_error' },
    ];

    const messages = errors.map((error) => describeApiError(error, de));

    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('names the specific budget a 429 spent, defaulting to polling', () => {
    const upload = describeApiError(
      { kind: 'rate_limited', retryAfterSeconds: 12 },
      de,
      'upload',
    );
    const polling = describeApiError(
      { kind: 'rate_limited', retryAfterSeconds: 12 },
      de,
    );

    expect(upload).toContain(de.errors.budget.upload);
    expect(polling).toContain(de.errors.budget.polling);
    expect(upload).not.toBe(polling);
  });

  it('states the real Retry-After seconds rather than a fixed wording', () => {
    const message = describeApiError(
      { kind: 'rate_limited', retryAfterSeconds: 77 },
      de,
    );

    expect(message).toContain('77');
  });
});
