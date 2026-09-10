import type { ApiError, ApiResult } from './errors';

type RuntimeSchema<T> = {
  safeParse: (
    input: unknown,
  ) => { success: true; data: T } | { success: false };
};

export const READ_REQUEST_TIMEOUT_MS = 15_000;

interface RequestOptions {
  init?: RequestInit;
  timeoutMs?: number;
}

interface FetchedResponse {
  response: Response;
  body: string;
}

async function rawFetch(
  path: string,
  { init, timeoutMs = READ_REQUEST_TIMEOUT_MS }: RequestOptions = {},
): Promise<FetchedResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    return { response, body: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshSession(): Promise<boolean> {
  const fetched = await rawFetch('/api/sessions', {
    init: { method: 'POST' },
  });
  return fetched !== null && fetched.response.ok;
}

export async function requestWithSessionRetry(
  path: string,
  options: RequestOptions = {},
): Promise<FetchedResponse | null> {
  const first = await rawFetch(path, options);
  if (first?.response.status === 401 && (await refreshSession())) {
    return rawFetch(path, options);
  }
  return first;
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('Retry-After');
  const parsed = header ? Number(header) : NaN;
  return Number.isFinite(parsed) ? parsed : 60;
}

function errorFromResponse(response: Response): ApiError {
  if (response.status === 401) return { kind: 'unauthorized' };
  if (response.status === 404) return { kind: 'not_found' };
  if (response.status === 409) return { kind: 'conflict' };
  if (response.status === 413) return { kind: 'payload_too_large' };
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }
  if (response.status === 400) return { kind: 'bad_request' };
  return { kind: 'server_error' };
}

export function classifyJson<T>(
  fetched: FetchedResponse | null,
  schema: RuntimeSchema<T>,
): ApiResult<T> {
  if (!fetched) return { ok: false, error: { kind: 'network_error' } };
  if (!fetched.response.ok) {
    return { ok: false, error: errorFromResponse(fetched.response) };
  }

  let body: unknown;
  try {
    body = JSON.parse(fetched.body);
  } catch {
    return { ok: false, error: { kind: 'parse_error' } };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: { kind: 'parse_error' } };
  return { ok: true, data: parsed.data };
}

export function classifyEmpty(
  fetched: FetchedResponse | null,
): ApiResult<void> {
  if (!fetched) return { ok: false, error: { kind: 'network_error' } };
  if (!fetched.response.ok) {
    return { ok: false, error: errorFromResponse(fetched.response) };
  }
  return { ok: true, data: undefined };
}
