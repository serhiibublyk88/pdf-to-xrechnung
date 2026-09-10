import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, FinishReason, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Env } from '../config/env.schema';
import {
  llmStatusError,
  MAX_OUTPUT_TOKENS,
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
  type LlmProvider,
  type RawLlmResponse,
} from './llm-provider.interface';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';
import { toGeminiResponseJsonSchema } from './provider-json-schema';

const RESPONSE_JSON_SCHEMA = toGeminiResponseJsonSchema(
  z.toJSONSchema(RawExtractedInvoiceDataSchema, { io: 'input' }),
);

@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<Env, true>) {
    this.model = configService.get('GEMINI_MODEL');
    this.timeoutMs = configService.get('LLM_REQUEST_TIMEOUT_MS');
    this.client = new GoogleGenAI({
      apiKey: configService.get('GEMINI_API_KEY'),
    });
  }

  async extract(prompt: string): Promise<RawLlmResponse> {
    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_JSON_SCHEMA,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          httpOptions: { timeout: this.timeoutMs },
        },
      });
    } catch (error) {
      if (error instanceof ApiError) {
        const statusError = llmStatusError('Gemini', error.status);
        if (statusError) {
          throw statusError;
        }
      }
      throw new RetryableLlmProviderError(
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = response.text;
    if (!text) {
      throw new NonRetryableLlmProviderError(
        'Gemini returned an empty response (possibly blocked by safety filters)',
      );
    }

    return {
      text,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      truncated:
        response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS,
    };
  }
}
