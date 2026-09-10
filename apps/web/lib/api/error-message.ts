import type { Dictionary } from '@/lib/i18n/dictionary';
import type { ApiError } from './errors';

export type RateLimitBudget = 'upload' | 'review' | 'retry' | 'polling';

export function describeApiError(
  error: ApiError,
  dictionary: Dictionary,
  budget: RateLimitBudget = 'polling',
): string {
  switch (error.kind) {
    case 'bad_request':
      return dictionary.errors.badRequest;
    case 'unauthorized':
      return dictionary.errors.unauthorized;
    case 'not_found':
      return dictionary.errors.notFound;
    case 'conflict':
      return dictionary.errors.conflict;
    case 'payload_too_large':
      return dictionary.errors.payloadTooLarge;
    case 'rate_limited':
      return dictionary.errors.rateLimited(
        error.retryAfterSeconds,
        dictionary.errors.budget[budget],
      );
    case 'network_error':
      return dictionary.errors.networkError;
    case 'parse_error':
      return dictionary.errors.parseError;
    case 'server_error':
      return dictionary.errors.serverError;
  }
}
