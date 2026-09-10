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
import { toStrictResponseJsonSchema } from './provider-json-schema';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RESPONSE_JSON_SCHEMA = toStrictResponseJsonSchema(
  z.toJSONSchema(RawExtractedInvoiceDataSchema, { io: 'input' }),
);

const GroqResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

@Injectable()
export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<Env, true>) {
    this.model = configService.get('GROQ_MODEL');
    this.apiKey = configService.get('GROQ_API_KEY');
    this.timeoutMs = configService.get('LLM_REQUEST_TIMEOUT_MS');
  }

  async extract(prompt: string): Promise<RawLlmResponse> {
    const { status, body: responseText } = await fetchBody({
      input: GROQ_URL,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'raw_extracted_invoice_data',
              strict: true,
              schema: RESPONSE_JSON_SCHEMA,
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
      maxBytes: MAX_LLM_RESPONSE_BODY_BYTES,
      onTransportFailure: () =>
        new RetryableLlmProviderError('Groq transport failure'),
    });

    const statusError = llmStatusError('Groq', status);
    if (statusError) {
      throw statusError;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseText);
    } catch {
      throw new NonRetryableLlmProviderError(
        'Groq response was not valid JSON',
      );
    }

    const parsed = GroqResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new NonRetryableLlmProviderError(
        'Groq response did not match the chat-completion contract',
      );
    }
    const choice = parsed.data.choices[0];
    const content = choice?.message.content;
    if (!content)
      throw new NonRetryableLlmProviderError('Groq returned an empty response');
    return {
      text: content,
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      truncated: choice.finish_reason === 'length',
    };
  }
}
