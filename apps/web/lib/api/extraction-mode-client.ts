import { boolean, object } from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import type { ApiResult } from './errors';
import { classifyJson, requestWithSessionRetry } from './request';

const extractionModeSchema = object({ demo: boolean() });

export async function getExtractionMode(): Promise<
  ApiResult<ZodInfer<typeof extractionModeSchema>>
> {
  const response = await requestWithSessionRetry('/api/extraction-mode');
  return classifyJson(response, extractionModeSchema);
}
