import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Env } from '../config/env.schema';
import { fetchBody } from '../http/guarded-fetch';
import {
  llmStatusError,
  MAX_LLM_RESPONSE_BODY_BYTES,
  MAX_OUTPUT_TOKENS,
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
  type LlmProvider,
  type RawLlmResponse,
} from './llm-provider.interface';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';

const RESPONSE_JSON_SCHEMA = z.toJSONSchema(RawExtractedInvoiceDataSchema, {
  io: 'input',
});
const JSON_ONLY_SYSTEM_MESSAGE =
  'Return only the JSON object required by the schema. Do not include reasoning, markdown, or commentary.';

const OllamaResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  done_reason: z.string().optional(),
});

@Injectable()
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<Env, true>) {
    this.model = configService.get('OLLAMA_MODEL');
    this.baseUrl = configService.get('OLLAMA_BASE_URL');
    this.timeoutMs = configService.get('LLM_REQUEST_TIMEOUT_MS');
  }

  async extract(prompt: string): Promise<RawLlmResponse> {
    const { status, body: responseText } = await fetchBody({
      input: new URL('/api/chat', this.baseUrl),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: JSON_ONLY_SYSTEM_MESSAGE },
            { role: 'user', content: prompt },
          ],
          stream: false,
          think: false,
          format: RESPONSE_JSON_SCHEMA,
          options: { temperature: 0, num_predict: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
      maxBytes: MAX_LLM_RESPONSE_BODY_BYTES,
      onTransportFailure: () =>
        new RetryableLlmProviderError('Ollama transport failure'),
    });

    const statusError = llmStatusError('Ollama', status);
    if (statusError) {
      throw statusError;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseText);
    } catch {
      throw new NonRetryableLlmProviderError(
        'Ollama response was not valid JSON',
      );
    }

    const parsed = OllamaResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new NonRetryableLlmProviderError(
        'Ollama response did not match the chat contract',
      );
    }
    if (!parsed.data.message.content) {
      throw new NonRetryableLlmProviderError(
        'Ollama returned an empty response',
      );
    }
    return {
      text: parsed.data.message.content,
      inputTokens: parsed.data.prompt_eval_count ?? null,
      outputTokens: parsed.data.eval_count ?? null,
      truncated: parsed.data.done_reason === 'length',
    };
  }
}
