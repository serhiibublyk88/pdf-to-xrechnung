import type { z as MiniZod } from 'zod/mini';

export type InvoiceFailureZod = Pick<
  typeof MiniZod,
  'array' | 'discriminatedUnion' | 'literal' | 'number' | 'object'
>;

const failureCodes = {
  pdfUnreadable: 'pdf_unreadable',
  pdfNoPages: 'pdf_no_pages',
  pdfTooManyPages: 'pdf_too_many_pages',
  pdfResourceLimit: 'pdf_resource_limit',
  ocrTextTooSparse: 'ocr_text_too_sparse',
  ocrConfidenceTooLow: 'ocr_confidence_too_low',
  textTooLong: 'text_too_long',
  textExtractionRetriesExhausted: 'text_extraction_retries_exhausted',
  llmProviderError: 'llm_provider_error',
  llmResponseNotJson: 'llm_response_not_json',
  llmResponseSchemaMismatch: 'llm_response_schema_mismatch',
  llmResponseTruncated: 'llm_response_truncated',
  llmNoUsableData: 'llm_no_usable_data',
  dataExtractionRetriesExhausted: 'data_extraction_retries_exhausted',
  validationRetriesExhausted: 'validation_retries_exhausted',
  generationRetriesExhausted: 'generation_retries_exhausted',
} as const;

export const INVOICE_FAILURE_CODES = Object.values(failureCodes);

export function createInvoiceFailureSchema(schema: InvoiceFailureZod) {
  return schema.discriminatedUnion('code', [
    schema.object({ code: schema.literal(failureCodes.pdfUnreadable) }),
    schema.object({ code: schema.literal(failureCodes.pdfNoPages) }),
    schema.object({ code: schema.literal(failureCodes.pdfResourceLimit) }),
    schema.object({
      code: schema.literal(failureCodes.pdfTooManyPages),
      params: schema.object({
        pageCount: schema.number(),
        limit: schema.number(),
      }),
    }),
    schema.object({
      code: schema.literal(failureCodes.ocrTextTooSparse),
      params: schema.object({ pages: schema.array(schema.number()) }),
    }),
    schema.object({
      code: schema.literal(failureCodes.ocrConfidenceTooLow),
      params: schema.object({
        lowestPageConfidence: schema.number(),
        minimum: schema.number(),
      }),
    }),
    schema.object({
      code: schema.literal(failureCodes.textTooLong),
      params: schema.object({
        charCount: schema.number(),
        limit: schema.number(),
      }),
    }),
    schema.object({
      code: schema.literal(failureCodes.textExtractionRetriesExhausted),
    }),
    schema.object({ code: schema.literal(failureCodes.llmProviderError) }),
    schema.object({ code: schema.literal(failureCodes.llmResponseNotJson) }),
    schema.object({
      code: schema.literal(failureCodes.llmResponseSchemaMismatch),
    }),
    schema.object({ code: schema.literal(failureCodes.llmResponseTruncated) }),
    schema.object({ code: schema.literal(failureCodes.llmNoUsableData) }),
    schema.object({
      code: schema.literal(failureCodes.dataExtractionRetriesExhausted),
    }),
    schema.object({
      code: schema.literal(failureCodes.validationRetriesExhausted),
    }),
    schema.object({
      code: schema.literal(failureCodes.generationRetriesExhausted),
    }),
  ]);
}
