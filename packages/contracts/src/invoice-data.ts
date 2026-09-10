import {
  _default,
  array,
  enum as zEnum,
  int,
  maxLength,
  nullable,
  pipe,
  positive,
  refine,
  regex,
  strictObject,
  string,
  transform,
} from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import {
  canonicalDecimalPattern,
  countryCodePattern,
  createInvoiceDataSchemas,
  currencyCodePattern,
  isoDatePattern,
  MAX_DECIMAL_LENGTH,
  MAX_LINE_ITEMS,
  MAX_TEXT_LENGTH,
  MAX_VAT_BREAKDOWNS,
  MAX_VAT_ID_LENGTH,
} from './invoice-data-definition';

export {
  canonicalDecimalPattern,
  countryCodePattern,
  currencyCodePattern,
  isoDatePattern,
  MAX_DECIMAL_LENGTH,
  MAX_LINE_ITEMS,
  MAX_TEXT_LENGTH,
  MAX_VAT_BREAKDOWNS,
  MAX_VAT_ID_LENGTH,
};

export const {
  LineItemSchema,
  PartySchema,
  RawExtractedInvoiceDataSchema,
  VatBreakdownSchema,
} = createInvoiceDataSchemas({
  _default,
  array,
  enum: zEnum,
  int,
  maxLength,
  nullable,
  pipe,
  positive,
  refine,
  regex,
  strictObject,
  string,
  transform,
});

export type Party = ZodInfer<typeof PartySchema>;
export type LineItem = ZodInfer<typeof LineItemSchema>;
export type VatBreakdown = ZodInfer<typeof VatBreakdownSchema>;
export type RawExtractedInvoiceData = ZodInfer<
  typeof RawExtractedInvoiceDataSchema
>;
