import { parseInvoiceFailure } from './invoice-failure.schema';
import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';

const invoiceId = 'invoice-technical-id';

function loggerMock() {
  return { warn: jest.fn() };
}

function parse(failureCode: string | null, failureParams: unknown) {
  const logger = loggerMock();
  const result = parseInvoiceFailure(
    { failureCode, failureParams, invoiceId },
    logger,
  );
  return { result, logger };
}

describe('parseInvoiceFailure', () => {
  it('returns null and does not warn for a normal null/null pair', () => {
    const { result, logger } = parse(null, null);
    expect(result).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reconstructs a parameterless code with no warning', () => {
    const { result, logger } = parse('llm_provider_error', null);
    expect(result).toEqual({ code: 'llm_provider_error' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each<[string, InvoiceFailure]>([
    [
      'pdf_too_many_pages',
      { code: 'pdf_too_many_pages', params: { pageCount: 42, limit: 30 } },
    ],
    [
      'ocr_text_too_sparse',
      { code: 'ocr_text_too_sparse', params: { pages: [1, 2, 3] } },
    ],
    [
      'ocr_confidence_too_low',
      {
        code: 'ocr_confidence_too_low',
        params: { lowestPageConfidence: 12.5, minimum: 60 },
      },
    ],
    [
      'text_too_long',
      {
        code: 'text_too_long',
        params: { charCount: 600_000, limit: 500_000 },
      },
    ],
  ])('reconstructs the exact numeric params for %s', (code, expected) => {
    const failure = expected as Extract<InvoiceFailure, { params: unknown }>;
    const { result, logger } = parse(code, failure.params);
    expect(result).toEqual(expected);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is idempotent: re-parsing a canonical result produces the same value', () => {
    const first = parse('text_too_long', {
      charCount: 600_000,
      limit: 500_000,
    }).result;
    if (first === null || !('params' in first)) {
      throw new Error('expected a parameterized failure');
    }
    const second = parse('text_too_long', first.params).result;
    expect(second).toEqual(first);
  });

  it('strips root and nested extras via the shared tolerant schema', () => {
    const { result } = parse('text_too_long', {
      charCount: 600_000,
      limit: 500_000,
      filename: 'invoice.pdf',
    });
    expect(result).toEqual({
      code: 'text_too_long',
      params: { charCount: 600_000, limit: 500_000 },
    });
  });

  it('returns a legal code-only object when a parameterless code carries extra params', () => {
    const { result, logger } = parse('pdf_unreadable', { extra: 1 });
    expect(result).toEqual({ code: 'pdf_unreadable' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and warns exactly once for an unknown code', () => {
    const { result, logger } = parse('not_a_real_code', null);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns exactly once for a known code with malformed params', () => {
    const { result, logger } = parse('text_too_long', {
      charCount: 'not-a-number',
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns exactly once for orphan params with no failure code', () => {
    const { result, logger } = parse(null, { charCount: 1 });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs a generic message with the technical invoice ID, never the raw code or params', () => {
    const { logger } = parse('SYNTHETIC_INVOICE_CONTENT_MARKER', {
      privateField: 'SYNTHETIC_PARAMS_MARKER',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0] as [string];
    expect(message).toBe(
      `Ignoring invalid stored failure data for invoice ${invoiceId}`,
    );
    expect(message).not.toContain('SYNTHETIC_INVOICE_CONTENT_MARKER');
    expect(message).not.toContain('SYNTHETIC_PARAMS_MARKER');
  });

  it('uses the same generic message for an unknown code and for orphan params', () => {
    const unknownCode = parse('not_a_real_code', null).logger.warn.mock
      .calls[0] as [string];
    const orphanParams = parse(null, { charCount: 1 }).logger.warn.mock
      .calls[0] as [string];
    expect(unknownCode[0]).toBe(orphanParams[0]);
  });
});
