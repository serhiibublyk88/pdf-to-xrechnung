import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { GroqProvider } from './groq-provider';
import {
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
} from './llm-provider.interface';

function makeProvider(): GroqProvider {
  const configService = new ConfigService<Env, true>({
    GROQ_API_KEY: 'test-key',
    GROQ_MODEL: 'openai/gpt-oss-20b',
    LLM_REQUEST_TIMEOUT_MS: 30_000,
  });
  return new GroqProvider(configService);
}

describe('GroqProvider', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses the configured model and returns structured content with token usage', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"invoiceNumber":"RE-1"}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      ),
    );

    const extracted = await makeProvider().extract('JSON prompt');

    expect(makeProvider().name).toBe('groq');
    expect(makeProvider().model).toBe('openai/gpt-oss-20b');
    expect(extracted).toEqual({
      text: '{"invoiceNumber":"RE-1"}',
      inputTokens: 10,
      outputTokens: 5,
      truncated: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: unknown;
      max_tokens: number;
      response_format: unknown;
    };
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.messages).toEqual([{ role: 'user', content: 'JSON prompt' }]);
    expect(body.max_tokens).toBe(8192);
    const responseFormat = body.response_format as {
      type: string;
      json_schema: {
        name: string;
        strict: boolean;
        schema: {
          type: string;
          required: string[];
          additionalProperties: boolean;
          properties: {
            vatBreakdown: {
              items: {
                properties: Record<string, unknown>;
                required: string[];
              };
            };
          };
        };
      };
    };
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema.name).toBe('raw_extracted_invoice_data');
    expect(responseFormat.json_schema.strict).toBe(true);
    expect(responseFormat.json_schema.schema.type).toBe('object');
    expect(responseFormat.json_schema.schema.required).toContain(
      'invoiceNumber',
    );
    expect(responseFormat.json_schema.schema.additionalProperties).toBe(false);
    const vatBreakdownItem =
      responseFormat.json_schema.schema.properties.vatBreakdown.items;
    expect(vatBreakdownItem.required).not.toContain('category');
    expect(vatBreakdownItem.properties).not.toHaveProperty('category');
  });

  it('flags a response that hit the token cap as truncated', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"invoiceNumber": "RE-1"' },
              finish_reason: 'length',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const extracted = await makeProvider().extract('prompt');

    expect(extracted.truncated).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'treats HTTP %i as retryable',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));

      await expect(makeProvider().extract('prompt')).rejects.toBeInstanceOf(
        RetryableLlmProviderError,
      );
    },
  );

  it('does not retry a 400 bad request', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));

    await expect(makeProvider().extract('prompt')).rejects.not.toBeInstanceOf(
      RetryableLlmProviderError,
    );
  });

  it('carries the HTTP status on a non-retryable status failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 413 }));

    await expect(makeProvider().extract('prompt')).rejects.toMatchObject({
      name: 'LlmStatusError',
      status: 413,
    });
  });

  it('treats a transport failure as retryable with a safe stable message', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toBeInstanceOf(RetryableLlmProviderError);
    await expect(failure).rejects.toThrow('Groq transport failure');
  });

  it('treats a body-read failure on an otherwise successful response as retryable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('terminated')),
    });

    await expect(makeProvider().extract('prompt')).rejects.toBeInstanceOf(
      RetryableLlmProviderError,
    );
  });

  it('rejects a non-JSON response body deterministically', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toThrow('not valid JSON');
    await expect(
      failure.catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(NonRetryableLlmProviderError);
  });

  it('rejects a malformed provider response deterministically', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 123 } }] }),
        { status: 200 },
      ),
    );

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toThrow('chat-completion contract');
    await expect(
      failure.catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(NonRetryableLlmProviderError);
  });
});
