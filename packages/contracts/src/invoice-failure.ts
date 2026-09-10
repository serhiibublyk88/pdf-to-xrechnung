import { array, discriminatedUnion, literal, number, object } from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import {
  createInvoiceFailureSchema,
  INVOICE_FAILURE_CODES,
} from './invoice-failure-definition';

export { INVOICE_FAILURE_CODES };

export const InvoiceFailureSchema = createInvoiceFailureSchema({
  array,
  discriminatedUnion,
  literal,
  number,
  object,
});

export type InvoiceFailure = ZodInfer<typeof InvoiceFailureSchema>;
