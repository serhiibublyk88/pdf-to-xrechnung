import type {
  Party,
  RawExtractedInvoiceData,
} from '@pdf-to-xrechnung/contracts';

function isEmptyParty(party: Party): boolean {
  return Object.values(party).every((value) => value === null);
}

export function isEmptyExtraction(data: RawExtractedInvoiceData): boolean {
  return (
    data.invoiceNumber === null &&
    data.issueDate === null &&
    data.dueDate === null &&
    data.deliveryDate === null &&
    data.currency === null &&
    data.sellerIban === null &&
    data.sellerBic === null &&
    data.netTotal === null &&
    data.vatTotal === null &&
    data.grossTotal === null &&
    data.paymentTerms === null &&
    data.buyerReference === null &&
    data.lineItems.length === 0 &&
    data.vatBreakdown.length === 0 &&
    isEmptyParty(data.seller) &&
    isEmptyParty(data.buyer)
  );
}
