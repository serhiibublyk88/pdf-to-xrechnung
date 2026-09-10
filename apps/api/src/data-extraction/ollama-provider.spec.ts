import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';
import type { Env } from '../config/env.schema';
import {
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
} from './llm-provider.interface';
import { OllamaProvider } from './ollama-provider';

const EXPECTED_RESPONSE_JSON_SCHEMA = z.toJSONSchema(
  RawExtractedInvoiceDataSchema,
  { io: 'input' },
);

function makeProvider(): OllamaProvider {
  const configService = new ConfigService<Env, true>({
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: 'qwen3.8:27b-mlx',
    LLM_REQUEST_TIMEOUT_MS: 30_000,
  });
  return new OllamaProvider(configService);
}

describe('OllamaProvider', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses local structured output without reasoning and returns token usage', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '{"invoiceNumber":"RE-1"}' },
          prompt_eval_count: 10,
          eval_count: 5,
          done_reason: 'stop',
        }),
        { status: 200 },
      ),
    );

    const extracted = await makeProvider().extract('prompt');

    expect(extracted).toEqual({
      text: '{"invoiceNumber":"RE-1"}',
      inputTokens: 10,
      outputTokens: 5,
      truncated: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(init.body as string) as { format: unknown };
    expect(body).toMatchObject({
      model: 'qwen3.8:27b-mlx',
      messages: [{ role: 'system' }, { role: 'user', content: 'prompt' }],
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 8192 },
    });
    expect(body.format).toEqual(EXPECTED_RESPONSE_JSON_SCHEMA);
  });

  it('flags a response that hit the token cap as truncated', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '{"invoiceNumber": "RE-1"' },
          done_reason: 'length',
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

  it('treats a transport failure as retryable with a safe stable message', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toBeInstanceOf(RetryableLlmProviderError);
    await expect(failure).rejects.toThrow('Ollama transport failure');
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
      new Response(JSON.stringify({ message: { content: 123 } }), {
        status: 200,
      }),
    );

    const failure = makeProvider().extract('prompt');
    await expect(failure).rejects.toThrow('chat contract');
    await expect(
      failure.catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(NonRetryableLlmProviderError);
  });
});
