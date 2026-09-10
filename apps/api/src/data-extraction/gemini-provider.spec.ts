import { ConfigService } from '@nestjs/config';
import { ApiError, GoogleGenAI } from '@google/genai';
import type { Env } from '../config/env.schema';
import { GeminiProvider } from './gemini-provider';
import type { LlmProvider } from './llm-provider.interface';
import {
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
} from './llm-provider.interface';

const OMITTED_GEMINI_SCHEMA_KEYS = new Set([
  '$schema',
  'default',
  'exclusiveMinimum',
  'maximum',
  'maxItems',
  'maxLength',
  'pattern',
]);

function findSchemaKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(findSchemaKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...findSchemaKeys(child),
  ]);
}

jest.mock('@google/genai', () => {
  class MockApiError extends Error {
    status: number;
    constructor({ message, status }: { message: string; status: number }) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError: MockApiError,
    GoogleGenAI: jest.fn(),
    FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS' },
  };
});

interface FakeGenerateContentResult {
  text: string | undefined;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  candidates?: { finishReason?: string }[];
}

interface FakeGenerateContentParams {
  model: string;
  contents: string;
  config: {
    responseMimeType: string;
    responseJsonSchema?: unknown;
    maxOutputTokens?: number;
    httpOptions: { timeout: number };
  };
}

function makeProvider(): LlmProvider {
  const configService = new ConfigService<Env, true>({
    GEMINI_MODEL: 'gemini-3.5-flash',
    LLM_REQUEST_TIMEOUT_MS: 30_000,
    GEMINI_API_KEY: 'test-key',
  });
  return new GeminiProvider(configService);
}

describe('GeminiProvider', () => {
  let generateContent: jest.Mock<
    Promise<FakeGenerateContentResult>,
    [FakeGenerateContentParams]
  >;

  beforeEach(() => {
    generateContent = jest.fn<
      Promise<FakeGenerateContentResult>,
      [FakeGenerateContentParams]
    >();
    (GoogleGenAI as unknown as jest.Mock).mockImplementation(() => ({
      models: { generateContent },
    }));
  });

  it('identifies itself with the configured model', () => {
    expect(makeProvider().model).toBe('gemini-3.5-flash');
    expect(makeProvider().name).toBe('gemini');
  });

  it('returns text and token usage on success, bounded by the configured timeout', async () => {
    generateContent.mockResolvedValue({
      text: '{"invoiceNumber":"RE-1"}',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [{ finishReason: 'STOP' }],
    });

    const extracted = await makeProvider().extract('prompt');

    expect(extracted).toEqual({
      text: '{"invoiceNumber":"RE-1"}',
      inputTokens: 10,
      outputTokens: 5,
      truncated: false,
    });
    const call = generateContent.mock.calls[0];
    if (!call) {
      throw new Error('generateContent was not called');
    }
    const [params] = call;
    expect(params.model).toBe('gemini-3.5-flash');
    expect(params.contents).toBe('prompt');
    expect(params.config.responseMimeType).toBe('application/json');
    const responseJsonSchema = params.config.responseJsonSchema as {
      type: unknown;
      properties: Record<string, unknown>;
      additionalProperties: unknown;
    };
    expect(responseJsonSchema.type).toBe('object');
    expect(responseJsonSchema.additionalProperties).toBe(false);
    expect(Object.keys(responseJsonSchema.properties)).toEqual(
      expect.arrayContaining([
        'invoiceNumber',
        'seller',
        'lineItems',
        'vatBreakdown',
      ]),
    );
    expect(
      findSchemaKeys(params.config.responseJsonSchema).filter((key) =>
        OMITTED_GEMINI_SCHEMA_KEYS.has(key),
      ),
    ).toEqual([]);
    const schemaWithCategory = params.config.responseJsonSchema as {
      properties: {
        vatBreakdown: {
          items: {
            properties: { category: { anyOf: unknown[] } };
          };
        };
      };
    };
    const categoryVariants =
      schemaWithCategory.properties.vatBreakdown.items.properties.category
        .anyOf;
    expect(categoryVariants).toContainEqual({ type: 'null' });
    expect(
      categoryVariants.some(
        (variant) =>
          typeof variant === 'object' && variant !== null && 'enum' in variant,
      ),
    ).toBe(true);
    expect(params.config.maxOutputTokens).toBe(8192);
    expect(params.config.httpOptions).toEqual({ timeout: 30_000 });
  });

  it('treats a null token count as unknown rather than zero', async () => {
    generateContent.mockResolvedValue({ text: '{}', usageMetadata: {} });

    const extracted = await makeProvider().extract('prompt');

    expect(extracted.inputTokens).toBeNull();
    expect(extracted.outputTokens).toBeNull();
  });

  it('flags a response that hit the output-token cap as truncated', async () => {
    generateContent.mockResolvedValue({
      text: '{"invoiceNumber": "RE-1"',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });

    const extracted = await makeProvider().extract('prompt');

    expect(extracted.truncated).toBe(true);
  });

  it('does not flag a response that finished normally as truncated', async () => {
    generateContent.mockResolvedValue({
      text: '{}',
      candidates: [{ finishReason: 'STOP' }],
    });

    const extracted = await makeProvider().extract('prompt');

    expect(extracted.truncated).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'retries on HTTP %i',
    async (status) => {
      generateContent.mockRejectedValue(
        new ApiError({ message: 'transient', status }),
      );

      await expect(makeProvider().extract('prompt')).rejects.toBeInstanceOf(
        RetryableLlmProviderError,
      );
    },
  );

  it('does not retry a 400 bad request', async () => {
    generateContent.mockRejectedValue(
      new ApiError({ message: 'bad request', status: 400 }),
    );

    await expect(makeProvider().extract('prompt')).rejects.toMatchObject({
      name: 'LlmStatusError',
      status: 400,
    });
  });

  it('does not retry a 401 auth failure', async () => {
    generateContent.mockRejectedValue(
      new ApiError({ message: 'unauthorized', status: 401 }),
    );

    await expect(makeProvider().extract('prompt')).rejects.toMatchObject({
      name: 'LlmStatusError',
      status: 401,
    });
  });

  it('carries the HTTP status through a safe typed error, dropping the SDK message', async () => {
    generateContent.mockRejectedValue(
      new ApiError({ message: 'private-sentinel-request-body', status: 413 }),
    );

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toMatchObject({
      name: 'LlmStatusError',
      status: 413,
    });
    await expect(
      failure.catch((error: unknown) => (error as Error).message),
    ).resolves.not.toContain('private-sentinel-request-body');
  });

  it('treats a transport-level failure (no HTTP status) as retryable', async () => {
    generateContent.mockRejectedValue(new Error('fetch failed'));

    await expect(makeProvider().extract('prompt')).rejects.toBeInstanceOf(
      RetryableLlmProviderError,
    );
  });

  it('fails deterministically, not retryably, on an empty response', async () => {
    generateContent.mockResolvedValue({ text: undefined, usageMetadata: {} });

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toThrow('empty response');
    await expect(
      failure.catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(NonRetryableLlmProviderError);
  });
});
