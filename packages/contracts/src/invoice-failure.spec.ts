import {
  InvoiceFailureSchema,
  INVOICE_FAILURE_CODES,
  type InvoiceFailure,
} from './invoice-failure';

const legalSamples: InvoiceFailure[] = [
  { code: 'pdf_unreadable' },
  { code: 'pdf_no_pages' },
  { code: 'pdf_resource_limit' },
  { code: 'pdf_too_many_pages', params: { pageCount: 42, limit: 30 } },
  { code: 'ocr_text_too_sparse', params: { pages: [1, 2, 3] } },
  {
    code: 'ocr_confidence_too_low',
    params: { lowestPageConfidence: 12.5, minimum: 60 },
  },
  { code: 'text_too_long', params: { charCount: 600_000, limit: 500_000 } },
  { code: 'text_extraction_retries_exhausted' },
  { code: 'llm_provider_error' },
  { code: 'llm_response_not_json' },
  { code: 'llm_response_schema_mismatch' },
  { code: 'llm_response_truncated' },
  { code: 'llm_no_usable_data' },
  { code: 'data_extraction_retries_exhausted' },
  { code: 'validation_retries_exhausted' },
  { code: 'generation_retries_exhausted' },
];

describe('InvoiceFailureSchema', () => {
  it('has exactly one legal sample per declared failure code', () => {
    expect(legalSamples.map((sample) => sample.code).sort()).toEqual(
      [...INVOICE_FAILURE_CODES].sort(),
    );
  });

  it.each(legalSamples.map((sample) => [sample.code, sample] as const))(
    'accepts the %s sample and round-trips it through JSON',
    (_code, sample) => {
      const parsed = InvoiceFailureSchema.safeParse(sample);
      expect(parsed.success).toBe(true);
      const roundTripped = InvoiceFailureSchema.safeParse(
        JSON.parse(JSON.stringify(sample)),
      );
      expect(roundTripped).toEqual(parsed);
    },
  );

  it('rejects an unknown code', () => {
    expect(
      InvoiceFailureSchema.safeParse({ code: 'unknown_failure' }).success,
    ).toBe(false);
  });

  it('accepts a deterministic PDF resource-limit failure', () => {
    expect(
      InvoiceFailureSchema.safeParse({ code: 'pdf_resource_limit' }),
    ).toEqual({ success: true, data: { code: 'pdf_resource_limit' } });
  });

  it('rejects a parameterized code missing its params', () => {
    expect(
      InvoiceFailureSchema.safeParse({ code: 'text_too_long' }).success,
    ).toBe(false);
  });

  it('rejects a parameterized code missing one required param key', () => {
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'text_too_long',
        params: { charCount: 600_000 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['a string', 'x'],
    ['a boolean', true],
    ['null', null],
    ['an object', {}],
    ['an array', []],
  ])('rejects a scalar param leaf given %s', (_label, invalidValue) => {
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'text_too_long',
        params: { charCount: invalidValue, limit: 500_000 },
      }).success,
    ).toBe(false);
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'ocr_confidence_too_low',
        params: { lowestPageConfidence: invalidValue, minimum: 60 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['a string', 'x'],
    ['a boolean', true],
    ['null', null],
    ['an object', {}],
  ])(
    'rejects an ocr_text_too_sparse pages array containing %s',
    (_label, invalidItem) => {
      expect(
        InvoiceFailureSchema.safeParse({
          code: 'ocr_text_too_sparse',
          params: { pages: [1, invalidItem] },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a non-finite %s in every numeric leaf', (_label, nonFinite) => {
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'pdf_too_many_pages',
        params: { pageCount: nonFinite, limit: 30 },
      }).success,
    ).toBe(false);
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'ocr_text_too_sparse',
        params: { pages: [nonFinite] },
      }).success,
    ).toBe(false);
    expect(
      InvoiceFailureSchema.safeParse({
        code: 'text_too_long',
        params: { charCount: 100, limit: nonFinite },
      }).success,
    ).toBe(false);
  });

  it('strips an unknown root key from the parsed result', () => {
    const parsed = InvoiceFailureSchema.safeParse({
      code: 'llm_provider_error',
      message: 'private invoice content',
    });
    expect(parsed).toEqual({
      success: true,
      data: { code: 'llm_provider_error' },
    });
  });

  it('strips an unknown root key and an unknown nested params key from a parameterized result', () => {
    const parsed = InvoiceFailureSchema.safeParse({
      code: 'text_too_long',
      message: 'private invoice content',
      params: { charCount: 600_000, limit: 500_000, filename: 'invoice.pdf' },
    });
    expect(parsed).toEqual({
      success: true,
      data: {
        code: 'text_too_long',
        params: { charCount: 600_000, limit: 500_000 },
      },
    });
  });

  it('returns a canonical code-only object when a parameterless code carries extra params', () => {
    const parsed = InvoiceFailureSchema.safeParse({
      code: 'pdf_unreadable',
      params: { charCount: 1 },
    });
    expect(parsed).toEqual({ success: true, data: { code: 'pdf_unreadable' } });
  });
});
