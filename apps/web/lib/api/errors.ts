export type ApiError =
  | { kind: 'bad_request' }
  | { kind: 'unauthorized' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'payload_too_large' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'server_error' }
  | { kind: 'network_error' }
  | { kind: 'parse_error' };

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: ApiError };
