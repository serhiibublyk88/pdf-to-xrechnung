import { UntrustedBoundaryError } from '../config/log-redaction';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export class RetryableLlmProviderError extends UntrustedBoundaryError {}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export class NonRetryableLlmProviderError extends UntrustedBoundaryError {}

export class LlmStatusError extends NonRetryableLlmProviderError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmStatusError';
  }
}

// The provider's error body is left out: one of them echoes the request back into logs.
export function llmStatusError(provider: string, status: number): Error | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  const message = `${provider} request failed with status ${status}`;
  return RETRYABLE_STATUS_CODES.has(status)
    ? new RetryableLlmProviderError(message)
    : new LlmStatusError(message, status);
}

export const MAX_OUTPUT_TOKENS = 8192;
export const MAX_LLM_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface RawLlmResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  truncated: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  extract(prompt: string): Promise<RawLlmResponse>;
}
