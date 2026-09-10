import {
  _default,
  array,
  discriminatedUnion,
  enum as zEnum,
  int,
  maxLength,
  iso,
  literal,
  null as nullSchema,
  nullable,
  object,
  pipe,
  positive,
  refine,
  regex,
  strictObject,
  string,
  transform,
} from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import { createInvoiceDataSchemas } from '@pdf-to-xrechnung/contracts/invoice-data-definition';
import { createReviewResultSchema } from '@pdf-to-xrechnung/contracts/review-result-definition';
import {
  invoiceDeadLetterSchema,
  invoiceFailureSchema,
  invoiceFindingSchema,
  invoiceStatusSchema,
  lifecycleTokenSchema,
  sourceTypeSchema,
} from './base-schemas';

export * from './base-schemas';

export const { RawExtractedInvoiceDataSchema } = createInvoiceDataSchemas({
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

export type {
  LineItem,
  Party,
  RawExtractedInvoiceData,
  VatBreakdown,
} from '@pdf-to-xrechnung/contracts';

export const invoiceDetailSchema = object({
  id: string(),
  originalFilename: string(),
  status: invoiceStatusSchema,
  sourceType: sourceTypeSchema,
  pageCount: nullable(int()),
  failure: nullable(invoiceFailureSchema),
  expiresAt: iso.datetime(),
  reviewedAt: nullable(iso.datetime()),
  extractedData: nullable(RawExtractedInvoiceDataSchema),
  lifecycleToken: nullable(lifecycleTokenSchema),
  findings: array(invoiceFindingSchema),
  deadLetter: nullable(invoiceDeadLetterSchema),
}).check(
  refine(
    ({ status, lifecycleToken }) =>
      status === 'NEEDS_REVIEW'
        ? lifecycleToken !== null
        : lifecycleToken === null,
    { path: ['lifecycleToken'] },
  ),
);
export type InvoiceDetail = ZodInfer<typeof invoiceDetailSchema>;

export const reviewResultSchema = createReviewResultSchema({
  discriminatedUnion,
  literal,
  null: nullSchema,
  object,
  regex,
  string,
});
export type ReviewResult = ZodInfer<typeof reviewResultSchema>;
