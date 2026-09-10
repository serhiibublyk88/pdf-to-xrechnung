import {
  InvoiceFailureSchema,
  type InvoiceFailure,
} from '@pdf-to-xrechnung/contracts';
import type { Logger } from '@nestjs/common';

export function parseInvoiceFailure(
  {
    failureCode,
    failureParams,
    invoiceId,
  }: { failureCode: string | null; failureParams: unknown; invoiceId: string },
  logger: Pick<Logger, 'warn'>,
): InvoiceFailure | null {
  if (failureCode === null) {
    if (failureParams !== null) {
      logger.warn(
        `Ignoring invalid stored failure data for invoice ${invoiceId}`,
      );
    }
    return null;
  }

  const parsedFailure = InvoiceFailureSchema.safeParse(
    failureParams === null
      ? { code: failureCode }
      : { code: failureCode, params: failureParams },
  );
  if (parsedFailure.success) {
    return parsedFailure.data;
  }

  logger.warn(`Ignoring invalid stored failure data for invoice ${invoiceId}`);
  return null;
}
