import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';
import { isEmptyExtraction } from './empty-extraction';

function emptyParty() {
  return {
    name: null,
    street: null,
    postalCode: null,
    city: null,
    countryCode: null,
    vatId: null,
    taxNumber: null,
    electronicAddress: null,
    electronicAddressScheme: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function emptyData(): RawExtractedInvoiceData {
  return {
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    deliveryDate: null,
    currency: null,
    seller: emptyParty(),
    buyer: emptyParty(),
    sellerIban: null,
    sellerBic: null,
    lineItems: [],
    netTotal: null,
    vatBreakdown: [],
    vatTotal: null,
    grossTotal: null,
    paymentTerms: null,
    buyerReference: null,
  };
}

describe('isEmptyExtraction', () => {
  it('is true for an all-null response with no lines', () => {
    expect(isEmptyExtraction(emptyData())).toBe(true);
  });

  it('is false once a single leaf field is populated', () => {
    expect(isEmptyExtraction({ ...emptyData(), invoiceNumber: 'RE-1' })).toBe(
      false,
    );
  });

  it('is false once a party field is populated', () => {
    const data = emptyData();
    data.seller.name = 'Muster GmbH';
    expect(isEmptyExtraction(data)).toBe(false);
  });

  it('is false once a line item is present', () => {
    const data = emptyData();
    data.lineItems = [
      {
        position: 1,
        description: null,
        quantity: null,
        unit: null,
        unitPrice: null,
        netAmount: null,
        vatRate: null,
        vatExemptionReason: null,
      },
    ];
    expect(isEmptyExtraction(data)).toBe(false);
  });
});
