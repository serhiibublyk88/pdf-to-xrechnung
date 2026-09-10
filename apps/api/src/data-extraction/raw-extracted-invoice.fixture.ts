import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';

function isoDateOffsetFromToday(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function buildValidRawExtractedInvoiceData(): RawExtractedInvoiceData {
  return {
    invoiceNumber: 'RE-2026-001',
    issueDate: isoDateOffsetFromToday(0),
    dueDate: isoDateOffsetFromToday(30),
    deliveryDate: isoDateOffsetFromToday(-1),
    currency: 'EUR',
    seller: {
      name: 'Seller GmbH',
      street: 'Musterstrasse 1',
      postalCode: '10115',
      city: 'Berlin',
      countryCode: 'DE',
      vatId: 'DE136695976',
      taxNumber: null,
      electronicAddress: 'seller-routing-id',
      electronicAddressScheme: '0204',
      contactName: 'Anna Mustermann',
      contactEmail: 'rechnung@example.test',
      contactPhone: '+49 30 1234567',
    },
    buyer: {
      name: 'Buyer AG',
      street: 'Kaeuferweg 5',
      postalCode: '80331',
      city: 'Muenchen',
      countryCode: 'DE',
      vatId: null,
      taxNumber: null,
      electronicAddress: 'buyer-routing-id',
      electronicAddressScheme: '0204',
      contactName: null,
      contactEmail: 'buchhaltung@example.test',
      contactPhone: null,
    },
    sellerIban: 'DE89370400440532013000',
    sellerBic: null,
    lineItems: [
      {
        position: 1,
        description: 'Consulting service',
        quantity: '1',
        unit: 'Stück',
        unitPrice: '100.00',
        netAmount: '100.00',
        vatRate: '19',
        vatExemptionReason: null,
      },
    ],
    netTotal: '100.00',
    vatBreakdown: [
      {
        rate: '19',
        base: '100.00',
        amount: '19.00',
        category: null,
        exemptionReason: null,
      },
    ],
    vatTotal: '19.00',
    grossTotal: '119.00',
    paymentTerms: null,
    buyerReference: 'PO-2026-001',
  };
}
