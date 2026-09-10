import {
  array,
  boolean,
  discriminatedUnion,
  enum as zEnum,
  int,
  iso,
  literal,
  nullable,
  number,
  object,
  regex,
  string,
} from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import { createInvoiceFailureSchema } from '@pdf-to-xrechnung/contracts/invoice-failure-definition';
import { lifecycleTokenPattern } from '@pdf-to-xrechnung/contracts/review-result-definition';

const InvoiceFailureSchema = createInvoiceFailureSchema({
  array,
  discriminatedUnion,
  literal,
  number,
  object,
});

export const invoiceStatusSchema = zEnum([
  'UPLOADED',
  'EXTRACTING_TEXT',
  'TEXT_READY',
  'EXTRACTING_DATA',
  'DATA_READY',
  'VALIDATING',
  'NEEDS_REVIEW',
  'GENERATING',
  'GENERATING_DOCUMENT',
  'READY',
  'FAILED',
]);
export type InvoiceStatus = ZodInfer<typeof invoiceStatusSchema>;

export const terminalStatuses: ReadonlySet<InvoiceStatus> = new Set([
  'NEEDS_REVIEW',
  'READY',
  'FAILED',
]);

export const sourceTypeSchema = zEnum(['NATIVE', 'OCR', 'UNKNOWN']);
export type SourceType = ZodInfer<typeof sourceTypeSchema>;

const severitySchema = zEnum(['ERROR', 'WARNING', 'INFO']);

const pipelineStageSchema = zEnum([
  'text-extraction',
  'data-extraction',
  'validation',
  'generation',
]);
export type PipelineStage = ZodInfer<typeof pipelineStageSchema>;

export const invoiceFindingSchema = object({
  rule: string(),
  field: nullable(string()),
  severity: severitySchema,
  passed: boolean(),
  message: string(),
  expected: nullable(string()),
  actual: nullable(string()),
});
export type InvoiceFinding = ZodInfer<typeof invoiceFindingSchema>;

export const invoiceDeadLetterSchema = object({
  stage: pipelineStageSchema,
  failedAt: iso.datetime(),
});
export type InvoiceDeadLetter = ZodInfer<typeof invoiceDeadLetterSchema>;

export const invoiceFailureSchema = InvoiceFailureSchema;
export type InvoiceFailure = ZodInfer<typeof invoiceFailureSchema>;

export const lifecycleTokenSchema = string().check(
  regex(lifecycleTokenPattern),
);

export const uploadAcceptedResultSchema = object({
  id: string(),
  status: invoiceStatusSchema,
  deduplicated: boolean(),
});
export type UploadAcceptedResult = ZodInfer<typeof uploadAcceptedResultSchema>;

const invoiceListItemSchema = object({
  id: string(),
  originalFilename: string(),
  status: invoiceStatusSchema,
  createdAt: iso.datetime(),
  expiresAt: iso.datetime(),
  failure: nullable(invoiceFailureSchema),
});
export type InvoiceListItem = ZodInfer<typeof invoiceListItemSchema>;

export const invoiceListResponseSchema = array(invoiceListItemSchema);

export const invoiceStatusResultSchema = object({
  id: string(),
  status: invoiceStatusSchema,
  sourceType: sourceTypeSchema,
  pageCount: nullable(int()),
  failure: nullable(invoiceFailureSchema),
});
export type InvoiceStatusResult = ZodInfer<typeof invoiceStatusResultSchema>;
