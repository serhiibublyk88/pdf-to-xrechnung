import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { createLlmProvider } from './data-extraction.module';
import { GeminiProvider } from './gemini-provider';
import { GroqProvider } from './groq-provider';
import { MockProvider } from './mock-provider';
import { OllamaProvider } from './ollama-provider';

jest.mock('./gemini-provider');
jest.mock('./groq-provider');
jest.mock('./ollama-provider');

function configWith(env: Partial<Env>): ConfigService<Env, true> {
  return new ConfigService<Env, true>(env);
}

describe('createLlmProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds MockProvider when the provider is mock, never constructing the Gemini client', () => {
    const provider = createLlmProvider(configWith({ LLM_PROVIDER: 'mock' }));

    expect(provider).toBeInstanceOf(MockProvider);
    expect(GeminiProvider).not.toHaveBeenCalled();
  });

  it('builds GeminiProvider when gemini is configured', () => {
    const provider = createLlmProvider(
      configWith({
        LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-3.5-flash',
        LLM_REQUEST_TIMEOUT_MS: 30_000,
      }),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(GeminiProvider).toHaveBeenCalledTimes(1);
  });

  it('builds GroqProvider when groq is configured', () => {
    const provider = createLlmProvider(
      configWith({
        LLM_PROVIDER: 'groq',
        GROQ_API_KEY: 'test-key',
        GROQ_MODEL: 'openai/gpt-oss-20b',
        LLM_REQUEST_TIMEOUT_MS: 30_000,
      }),
    );

    expect(provider).toBeInstanceOf(GroqProvider);
    expect(GroqProvider).toHaveBeenCalledTimes(1);
  });

  it('builds OllamaProvider when ollama is configured', () => {
    const provider = createLlmProvider(
      configWith({
        LLM_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        OLLAMA_MODEL: 'qwen3.8:27b-mlx',
        LLM_REQUEST_TIMEOUT_MS: 30_000,
      }),
    );

    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(OllamaProvider).toHaveBeenCalledTimes(1);
  });
});
