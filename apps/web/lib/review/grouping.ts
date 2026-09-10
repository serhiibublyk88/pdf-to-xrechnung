import { terminalStatuses, type InvoiceListItem } from '@/lib/api/schemas';

const invoiceGroupIds = [
  'needsReview',
  'inProgress',
  'ready',
  'failed',
] as const;
type InvoiceGroupId = (typeof invoiceGroupIds)[number];

export interface InvoiceGroup {
  id: InvoiceGroupId;
  invoices: InvoiceListItem[];
}

function groupFor(invoice: InvoiceListItem): InvoiceGroupId {
  if (invoice.status === 'NEEDS_REVIEW') return 'needsReview';
  if (invoice.status === 'READY') return 'ready';
  if (invoice.status === 'FAILED') return 'failed';
  return 'inProgress';
}

export function groupInvoices(invoices: InvoiceListItem[]): InvoiceGroup[] {
  return invoiceGroupIds
    .map((id) => ({
      id,
      invoices: invoices.filter((invoice) => groupFor(invoice) === id),
    }))
    .filter((group) => group.invoices.length > 0);
}

export function hasNonTerminal(invoices: InvoiceListItem[]): boolean {
  return invoices.some((invoice) => !terminalStatuses.has(invoice.status));
}
