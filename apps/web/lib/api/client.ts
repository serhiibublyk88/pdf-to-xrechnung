import type { ApiResult } from './errors';
import type {
  InvoiceDetail,
  InvoiceStatusResult,
  RawExtractedInvoiceData,
  ReviewResult,
} from './schemas';
import {
  invoiceDetailSchema,
  invoiceStatusResultSchema,
  reviewResultSchema,
} from './schemas';
import {
  classifyEmpty,
  classifyJson,
  requestWithSessionRetry,
} from './request';

export { READ_REQUEST_TIMEOUT_MS } from './request';

export async function getInvoiceStatus(
  id: string,
): Promise<ApiResult<InvoiceStatusResult>> {
  const response = await requestWithSessionRetry(`/api/invoices/${id}`);
  return classifyJson(response, invoiceStatusResultSchema);
}

export async function getInvoiceReview(
  id: string,
): Promise<ApiResult<InvoiceDetail>> {
  const response = await requestWithSessionRetry(`/api/invoices/${id}/review`);
  return classifyJson(response, invoiceDetailSchema);
}

export async function submitInvoiceReview(
  id: string,
  {
    lifecycleToken,
    correctedData,
  }: {
    lifecycleToken: string;
    correctedData: RawExtractedInvoiceData;
  },
): Promise<ApiResult<ReviewResult>> {
  const body = JSON.stringify({ lifecycleToken, correctedData });
  const response = await requestWithSessionRetry(`/api/invoices/${id}/review`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
  });
  return classifyJson(response, reviewResultSchema);
}

export async function retryDeadLetter(id: string): Promise<ApiResult<void>> {
  const response = await requestWithSessionRetry(
    `/api/invoices/${id}/dead-letter/retry`,
    { init: { method: 'POST' } },
  );
  return classifyEmpty(response);
}
