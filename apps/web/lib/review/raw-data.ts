import type { Party, VatBreakdown } from '@/lib/api/schemas';
import {
  emptyDraftLineItem,
  type DraftLineItem,
  type InvoiceDraft,
} from './draft';

function emptyVatBreakdown(): VatBreakdown {
  return {
    rate: null,
    base: null,
    amount: null,
    category: null,
    exemptionReason: null,
  };
}

type TopLevelField = Exclude<
  keyof InvoiceDraft,
  'seller' | 'buyer' | 'lineItems' | 'vatBreakdown'
>;

export function updateTopLevel(
  data: InvoiceDraft,
  field: TopLevelField,
  value: string | null,
): InvoiceDraft {
  return { ...data, [field]: value };
}

export function updateParty(
  data: InvoiceDraft,
  party: 'seller' | 'buyer',
  field: keyof Party,
  value: string | null,
): InvoiceDraft {
  return { ...data, [party]: { ...data[party], [field]: value } };
}

export function updateLineItem(
  data: InvoiceDraft,
  index: number,
  field: keyof DraftLineItem,
  value: string | null,
): InvoiceDraft {
  const lineItems = data.lineItems.map((item, itemIndex) =>
    itemIndex === index ? { ...item, [field]: value } : item,
  );
  return { ...data, lineItems };
}

export function addLineItem(data: InvoiceDraft): InvoiceDraft {
  return { ...data, lineItems: [...data.lineItems, emptyDraftLineItem()] };
}

export function removeLineItem(
  data: InvoiceDraft,
  index: number,
): InvoiceDraft {
  return {
    ...data,
    lineItems: data.lineItems.filter((_, itemIndex) => itemIndex !== index),
  };
}

export function updateVatBreakdown(
  data: InvoiceDraft,
  index: number,
  field: keyof VatBreakdown,
  value: string | null,
): InvoiceDraft {
  const vatBreakdown = data.vatBreakdown.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, [field]: value } : entry,
  );
  return { ...data, vatBreakdown };
}

export function addVatBreakdown(data: InvoiceDraft): InvoiceDraft {
  return { ...data, vatBreakdown: [...data.vatBreakdown, emptyVatBreakdown()] };
}

export function removeVatBreakdown(
  data: InvoiceDraft,
  index: number,
): InvoiceDraft {
  return {
    ...data,
    vatBreakdown: data.vatBreakdown.filter(
      (_, entryIndex) => entryIndex !== index,
    ),
  };
}
