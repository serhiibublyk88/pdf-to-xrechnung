import type { ApiResult } from './errors';
import {
  invoiceListResponseSchema,
  uploadAcceptedResultSchema,
  type InvoiceListItem,
  type UploadAcceptedResult,
} from './base-schemas';
import {
  classifyEmpty,
  classifyJson,
  requestWithSessionRetry,
} from './request';

const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

export async function uploadInvoice(
  file: File,
): Promise<ApiResult<UploadAcceptedResult>> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await requestWithSessionRetry('/api/invoices', {
    init: {
      method: 'POST',
      body: formData,
    },
    timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
  });
  return classifyJson(response, uploadAcceptedResultSchema);
}

export async function listInvoices(): Promise<ApiResult<InvoiceListItem[]>> {
  const response = await requestWithSessionRetry('/api/invoices');
  return classifyJson(response, invoiceListResponseSchema);
}

export async function deleteInvoice(id: string): Promise<ApiResult<void>> {
  const response = await requestWithSessionRetry(`/api/invoices/${id}`, {
    init: { method: 'DELETE' },
  });
  return classifyEmpty(response);
}
