import { describe, expect, it } from 'vitest';
import { INVOICE_FAILURE_CODES } from '@pdf-to-xrechnung/contracts';
import { invoiceFailureSchema, type InvoiceFailure } from '../api/schemas';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import { failureMessage } from './failure-message';

const cases = [
  {
    failure: { code: 'pdf_unreadable' },
    expected: { de: de.failure.pdfUnreadable, en: en.failure.pdfUnreadable },
  },
  {
    failure: { code: 'pdf_no_pages' },
    expected: { de: de.failure.pdfNoPages, en: en.failure.pdfNoPages },
  },
  {
    failure: {
      code: 'pdf_too_many_pages',
      params: { pageCount: 31, limit: 30 },
    },
    expected: {
      de: de.failure.pdfTooManyPages(31, 30),
      en: en.failure.pdfTooManyPages(31, 30),
    },
  },
  {
    failure: { code: 'pdf_resource_limit' },
    expected: {
      de: de.failure.pdfResourceLimit,
      en: en.failure.pdfResourceLimit,
    },
  },
  {
    failure: { code: 'ocr_text_too_sparse', params: { pages: [1, 2] } },
    expected: {
      de: de.failure.ocrTextTooSparse([1, 2]),
      en: en.failure.ocrTextTooSparse([1, 2]),
    },
  },
  {
    failure: {
      code: 'ocr_confidence_too_low',
      params: { lowestPageConfidence: 74.2, minimum: 80 },
    },
    expected: {
      de: de.failure.ocrConfidenceTooLow(74.2, 80),
      en: en.failure.ocrConfidenceTooLow(74.2, 80),
    },
  },
  {
    failure: {
      code: 'text_too_long',
      params: { charCount: 1001, limit: 1000 },
    },
    expected: {
      de: de.failure.textTooLong(1001, 1000),
      en: en.failure.textTooLong(1001, 1000),
    },
  },
  {
    failure: { code: 'text_extraction_retries_exhausted' },
    expected: {
      de: de.failure.textExtractionRetriesExhausted,
      en: en.failure.textExtractionRetriesExhausted,
    },
  },
  {
    failure: { code: 'llm_provider_error' },
    expected: {
      de: de.failure.llmProviderError,
      en: en.failure.llmProviderError,
    },
  },
  {
    failure: { code: 'llm_response_not_json' },
    expected: {
      de: de.failure.llmResponseNotJson,
      en: en.failure.llmResponseNotJson,
    },
  },
  {
    failure: { code: 'llm_response_schema_mismatch' },
    expected: {
      de: de.failure.llmResponseSchemaMismatch,
      en: en.failure.llmResponseSchemaMismatch,
    },
  },
  {
    failure: { code: 'llm_response_truncated' },
    expected: {
      de: de.failure.llmResponseTruncated,
      en: en.failure.llmResponseTruncated,
    },
  },
  {
    failure: { code: 'llm_no_usable_data' },
    expected: {
      de: de.failure.llmNoUsableData,
      en: en.failure.llmNoUsableData,
    },
  },
  {
    failure: { code: 'data_extraction_retries_exhausted' },
    expected: {
      de: de.failure.dataExtractionRetriesExhausted,
      en: en.failure.dataExtractionRetriesExhausted,
    },
  },
  {
    failure: { code: 'validation_retries_exhausted' },
    expected: {
      de: de.failure.validationRetriesExhausted,
      en: en.failure.validationRetriesExhausted,
    },
  },
  {
    failure: { code: 'generation_retries_exhausted' },
    expected: {
      de: de.failure.generationRetriesExhausted,
      en: en.failure.generationRetriesExhausted,
    },
  },
] satisfies readonly {
  failure: InvoiceFailure;
  expected: { de: string; en: string };
}[];

describe('failureMessage', () => {
  it('renders every shared failure code', () => {
    expect(cases.map(({ failure }) => failure.code)).toEqual(
      INVOICE_FAILURE_CODES,
    );
  });

  it.each(cases)(
    'routes $failure.code to the matching message in both application languages',
    ({ failure, expected }) => {
      expect(failureMessage(failure, de)).toBe(expected.de);
      expect(failureMessage(failure, en)).toBe(expected.en);
    },
  );

  it('rejects an unknown server failure code instead of rendering it', () => {
    expect(
      invoiceFailureSchema.safeParse({ code: 'unrecognized_failure' }).success,
    ).toBe(false);
  });
});
