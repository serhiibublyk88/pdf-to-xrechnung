export function invoiceSourceUrl(id: string): string {
  return `/api/invoices/${id}/source`;
}

export function invoiceDocumentUrl(id: string): string {
  return `/api/invoices/${id}/document`;
}
