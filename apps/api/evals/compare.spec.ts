import { compareFixture } from './compare';
import {
  GoldenFixtureSchema,
  type GoldenFixture,
} from './golden-fixture.schema';

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

const emptyLine = {
  position: 1,
  description: 'Beratung',
  quantity: '1',
  unit: 'Stück',
  unitPrice: '100.00',
  netAmount: '100.00',
  vatRate: '19',
  vatExemptionReason: null,
};

function vatEntry(rate: string) {
  return {
    rate,
    base: '100.00',
    amount: '19.00',
    category: null,
    exemptionReason: null,
  };
}

function fixtureWith(data: Partial<GoldenFixture['data']> = {}): GoldenFixture {
  return GoldenFixtureSchema.parse({
    meta: {
      id: '001-comparison-de',
      language: 'de',
      sourceType: 'native',
      content: 'invoice',
      pages: 1,
      expectedOutcome: 'success',
      expectedErrors: [],
      notes: 'Comparison unit test',
    },
    data: {
      invoiceNumber: 'RE-1',
      issueDate: '2026-01-01',
      dueDate: null,
      deliveryDate: null,
      currency: 'EUR',
      seller: emptyParty,
      buyer: emptyParty,
      sellerIban: null,
      sellerBic: null,
      lineItems: [emptyLine],
      netTotal: '100.00',
      vatBreakdown: [vatEntry('19')],
      vatTotal: '19.00',
      grossTotal: '119.00',
      paymentTerms: null,
      buyerReference: null,
      ...data,
    },
  });
}

describe('compareFixture', () => {
  it('scores a unit price carrying more than two decimal places as a mismatch', () => {
    const fixture = fixtureWith();
    const extracted = structuredClone(fixture.data);
    extracted.lineItems[0]!.unitPrice = '10.005';

    const comparison = compareFixture(fixture, extracted);

    expect(comparison.lineFields).toEqual({ matched: 7, total: 8 });
    expect(comparison.mismatches).toContain(
      '001-comparison-de lineItems[0].unitPrice: expected "100.00", actual "10.005"',
    );
  });

  it('treats an equal value written at another scale as a match', () => {
    const fixture = fixtureWith();
    const extracted = structuredClone(fixture.data);
    extracted.vatBreakdown[0]!.rate = '19.00';
    extracted.lineItems[0]!.quantity = '1.000';

    const comparison = compareFixture(fixture, extracted);

    expect(comparison.mismatches).toEqual([]);
    expect(comparison.critical.matched).toBe(comparison.critical.total);
  });

  it('counts a VAT rate the extraction invented but the invoice does not have', () => {
    const fixture = fixtureWith();
    const extracted = structuredClone(fixture.data);
    extracted.vatBreakdown.push(vatEntry('7'));

    const comparison = compareFixture(fixture, extracted);

    expect(comparison.mismatches).toContain(
      '001-comparison-de vatBreakdown[1].rate: expected null, actual "7"',
    );

    expect(comparison.critical.total - comparison.critical.matched).toBe(3);
  });

  it('counts a wrong currency as a critical mismatch', () => {
    const fixture = fixtureWith({ currency: 'CHF' });
    const extracted = structuredClone(fixture.data);
    extracted.currency = 'EUR';

    const comparison = compareFixture(fixture, extracted);

    expect(comparison.mismatches).toContain(
      '001-comparison-de currency: expected "CHF", actual "EUR"',
    );
    expect(comparison.critical.total - comparison.critical.matched).toBe(1);
  });

  it('scores dueDate, sellerBic, party contact fields, and VAT base/amount/exemption', () => {
    const fixture = fixtureWith({
      dueDate: '2026-01-31',
      sellerBic: 'DEUTDEFF',
      seller: { ...emptyParty, contactEmail: 'billing@example.com' },
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
    const extracted = structuredClone(fixture.data);
    extracted.dueDate = '2026-02-28';
    extracted.sellerBic = 'COBADEFF';
    extracted.seller.contactEmail = 'wrong@example.com';
    extracted.vatBreakdown[0]!.base = '90.00';
    extracted.vatBreakdown[0]!.amount = '17.10';
    extracted.vatBreakdown[0]!.exemptionReason = 'Reverse charge';

    const comparison = compareFixture(fixture, extracted);

    expect(comparison.mismatches).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dueDate: expected "2026-01-31"'),
        expect.stringContaining('sellerBic: expected "DEUTDEFF"'),
        expect.stringContaining('seller.contactEmail'),
        expect.stringContaining('vatBreakdown[0].base'),
        expect.stringContaining('vatBreakdown[0].amount'),
        expect.stringContaining('vatBreakdown[0].exemptionReason'),
      ]),
    );
  });
});
