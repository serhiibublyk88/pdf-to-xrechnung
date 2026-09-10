import type { InvoiceFailure } from '../api/schemas';
import type { de } from '../i18n/de';

export function failureMessage(
  failure: InvoiceFailure,
  dictionary: typeof de,
): string {
  switch (failure.code) {
    case 'pdf_unreadable':
      return dictionary.failure.pdfUnreadable;
    case 'pdf_no_pages':
      return dictionary.failure.pdfNoPages;
    case 'pdf_resource_limit':
      return dictionary.failure.pdfResourceLimit;
    case 'pdf_too_many_pages':
      return dictionary.failure.pdfTooManyPages(
        failure.params.pageCount,
        failure.params.limit,
      );
    case 'ocr_text_too_sparse':
      return dictionary.failure.ocrTextTooSparse(failure.params.pages);
    case 'ocr_confidence_too_low':
      return dictionary.failure.ocrConfidenceTooLow(
        failure.params.lowestPageConfidence,
        failure.params.minimum,
      );
    case 'text_too_long':
      return dictionary.failure.textTooLong(
        failure.params.charCount,
        failure.params.limit,
      );
    case 'text_extraction_retries_exhausted':
      return dictionary.failure.textExtractionRetriesExhausted;
    case 'llm_provider_error':
      return dictionary.failure.llmProviderError;
    case 'llm_response_not_json':
      return dictionary.failure.llmResponseNotJson;
    case 'llm_response_schema_mismatch':
      return dictionary.failure.llmResponseSchemaMismatch;
    case 'llm_response_truncated':
      return dictionary.failure.llmResponseTruncated;
    case 'llm_no_usable_data':
      return dictionary.failure.llmNoUsableData;
    case 'data_extraction_retries_exhausted':
      return dictionary.failure.dataExtractionRetriesExhausted;
    case 'validation_retries_exhausted':
      return dictionary.failure.validationRetriesExhausted;
    case 'generation_retries_exhausted':
      return dictionary.failure.generationRetriesExhausted;
  }
}
