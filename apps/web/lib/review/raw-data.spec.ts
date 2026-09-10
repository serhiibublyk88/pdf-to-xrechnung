import { describe, expect, it } from 'vitest';
import {
  addLineItem,
  addVatBreakdown,
  removeLineItem,
  removeVatBreakdown,
  updateLineItem,
  updateParty,
  updateTopLevel,
  updateVatBreakdown,
} from './raw-data';
import type { InvoiceDraft } from './draft';

const emptyParty = {
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

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    deliveryDate: null,
    currency: null,
    seller: emptyParty,
    buyer: emptyParty,
    sellerIban: null,
    sellerBic: null,
    lineItems: [],
    netTotal: null,
    vatBreakdown: [],
    vatTotal: null,
    grossTotal: null,
    paymentTerms: null,
    buyerReference: null,
    ...overrides,
  };
}

describe('updateTopLevel', () => {
  it('sets the named field without mutating the original draft', () => {
    const original = draft();
    const updated = updateTopLevel(original, 'invoiceNumber', 'RE-1');

    expect(updated.invoiceNumber).toBe('RE-1');
    expect(original.invoiceNumber).toBeNull();
  });
});

describe('updateParty', () => {
  it("updates one field of the named party, leaving the other party and the party's other fields untouched", () => {
    const original = draft({ seller: { ...emptyParty, name: 'Original' } });
    const updated = updateParty(original, 'seller', 'city', 'Berlin');

    expect(updated.seller.city).toBe('Berlin');
    expect(updated.seller.name).toBe('Original');
    expect(updated.buyer).toEqual(emptyParty);
    expect(original.seller.city).toBeNull();
  });
});

describe('line items', () => {
  it('adds an empty line item without disturbing existing rows', () => {
    const original = draft({
      lineItems: [
        {
          position: '1',
          description: 'Existing',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
      ],
    });
    const updated = addLineItem(original);

    expect(updated.lineItems).toHaveLength(2);
    expect(updated.lineItems[0]?.description).toBe('Existing');
    expect(updated.lineItems[1]).toEqual({
      position: null,
      description: null,
      quantity: null,
      unit: null,
      unitPrice: null,
      netAmount: null,
      vatRate: null,
      vatExemptionReason: null,
    });
  });

  it('updates one field of the row at the given index only', () => {
    const original = draft({
      lineItems: [
        {
          position: '1',
          description: 'Row A',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
        {
          position: '2',
          description: 'Row B',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
      ],
    });
    const updated = updateLineItem(original, 1, 'description', 'Changed');

    expect(updated.lineItems[0]?.description).toBe('Row A');
    expect(updated.lineItems[1]?.description).toBe('Changed');
  });

  it('removes only the row at the given index, shifting the rest down', () => {
    const original = draft({
      lineItems: [
        {
          position: '1',
          description: 'Row A',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
        {
          position: '2',
          description: 'Row B',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
        {
          position: '3',
          description: 'Row C',
          quantity: null,
          unit: null,
          unitPrice: null,
          netAmount: null,
          vatRate: null,
          vatExemptionReason: null,
        },
      ],
    });
    const updated = removeLineItem(original, 1);

    expect(updated.lineItems.map((item) => item.description)).toEqual([
      'Row A',
      'Row C',
    ]);
  });
});

describe('VAT breakdown', () => {
  it('adds an empty entry without disturbing existing ones', () => {
    const original = draft({
      vatBreakdown: [
        {
          rate: '19',
          base: '100.00',
          amount: '19.00',
          category: null,
          exemptionReason: null,
        },
      ],
    });
    const updated = addVatBreakdown(original);

    expect(updated.vatBreakdown).toHaveLength(2);
    expect(updated.vatBreakdown[0]?.rate).toBe('19');
    expect(updated.vatBreakdown[1]).toEqual({
      rate: null,
      base: null,
      amount: null,
      category: null,
      exemptionReason: null,
    });
  });

  it('updates one field of the entry at the given index only', () => {
    const original = draft({
      vatBreakdown: [
        {
          rate: '19',
          base: '100.00',
          amount: '19.00',
          category: null,
          exemptionReason: null,
        },
        {
          rate: '7',
          base: '50.00',
          amount: '3.50',
          category: null,
          exemptionReason: null,
        },
      ],
    });
    const updated = updateVatBreakdown(original, 0, 'base', '200.00');

    expect(updated.vatBreakdown[0]?.base).toBe('200.00');
    expect(updated.vatBreakdown[1]?.base).toBe('50.00');
  });

  it('removes only the entry at the given index', () => {
    const original = draft({
      vatBreakdown: [
        {
          rate: '19',
          base: '100.00',
          amount: '19.00',
          category: null,
          exemptionReason: null,
        },
        {
          rate: '7',
          base: '50.00',
          amount: '3.50',
          category: null,
          exemptionReason: null,
        },
      ],
    });
    const updated = removeVatBreakdown(original, 0);

    expect(updated.vatBreakdown).toHaveLength(1);
    expect(updated.vatBreakdown[0]?.rate).toBe('7');
  });
});
