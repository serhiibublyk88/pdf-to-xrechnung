import { describe, expect, it } from 'vitest';
import {
  diffDraft,
  draftIssues,
  toDraft,
  toWire,
  type InvoiceDraft,
} from './draft';
import type { Party, RawExtractedInvoiceData } from '../api/schemas';

const emptyParty: Party = {
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

const wireData: RawExtractedInvoiceData = {
  invoiceNumber: '2026-0412',
  issueDate: '2026-04-12',
  dueDate: null,
  deliveryDate: null,
  currency: 'EUR',
  seller: { ...emptyParty, countryCode: 'DE' },
  buyer: { ...emptyParty, countryCode: 'DE' },
  sellerIban: null,
  sellerBic: null,
  lineItems: [
    {
      position: 1,
      description: 'Beratung',
      quantity: '2',
      unit: 'HUR',
      unitPrice: '595.00',
      netAmount: '1190.00',
      vatRate: '19',
      vatExemptionReason: null,
    },
  ],
  netTotal: '1190.00',
  vatBreakdown: [],
  vatTotal: '226.10',
  grossTotal: '1416.10',
  paymentTerms: null,
  buyerReference: null,
};

function draftOf(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return { ...toDraft(wireData), ...overrides };
}

describe('toDraft / toWire', () => {
  it('round-trips unchanged data', () => {
    const result = toWire(toDraft(wireData));

    expect(result.ok && result.data).toEqual(wireData);
  });

  it('carries the line-item position as text in the draft', () => {
    expect(toDraft(wireData).lineItems[0]?.position).toBe('1');
  });

  it('preserves null rather than coercing it to an empty string', () => {
    const result = toWire(toDraft(wireData));

    expect(result.ok && result.data.dueDate).toBeNull();
  });

  it('rejects a value the wire schema does not accept instead of throwing', () => {
    const result = toWire(draftOf({ grossTotal: '1.416,10' }));

    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric position instead of sending NaN', () => {
    const draft = draftOf();
    const result = toWire({
      ...draft,
      lineItems: [{ ...draft.lineItems[0]!, position: 'x' }],
    });

    expect(result.ok).toBe(false);
  });

  it('names failed collection paths in the form path grammar', () => {
    const draft = draftOf();
    const result = toWire({
      ...draft,
      grossTotal: '1.416,10',
      lineItems: [{ ...draft.lineItems[0]!, position: 'x' }],
      vatBreakdown: [
        {
          rate: '19',
          base: '1190.00',
          amount: '226.10',
          category: null,
          exemptionReason: '\u0007',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.paths).toEqual([
      'lineItems[0].position',
      'vatBreakdown[0].exemptionReason',
      'grossTotal',
    ]);
  });
});

describe('draftIssues', () => {
  it('accepts canonical data', () => {
    expect(draftIssues(toDraft(wireData))).toEqual([]);
  });

  it('blocks a German-formatted decimal', () => {
    expect(draftIssues(draftOf({ grossTotal: '1.416,10' }))).toEqual([
      { path: 'grossTotal', code: 'decimal', blocking: true },
    ]);
  });

  it('warns without blocking on a likely thousands separator', () => {
    expect(draftIssues(draftOf({ netTotal: '1.234' }))).toEqual([
      { path: 'netTotal', code: 'thousandsSeparator', blocking: false },
    ]);
  });

  it('warns on a three-decimal monetary value, which is wrong either way', () => {
    const draft = draftOf();
    const issues = draftIssues({
      ...draft,
      lineItems: [{ ...draft.lineItems[0]!, unitPrice: '1.234' }],
    });

    expect(issues).toEqual([
      {
        path: 'lineItems[0].unitPrice',
        code: 'thousandsSeparator',
        blocking: false,
      },
    ]);
  });

  it('leaves three-decimal quantities alone, where they are legitimate', () => {
    const draft = draftOf();
    const issues = draftIssues({
      ...draft,
      lineItems: [{ ...draft.lineItems[0]!, quantity: '0.125' }],
    });

    expect(issues).toEqual([]);
  });

  it('leaves a trailing-zero quantity alone', () => {
    const draft = draftOf();
    const issues = draftIssues({
      ...draft,
      lineItems: [{ ...draft.lineItems[0]!, quantity: '2.500' }],
    });

    expect(issues).toEqual([]);
  });

  it('blocks a lowercase country code, which the schema rejects', () => {
    const issues = draftIssues(
      draftOf({ seller: { ...emptyParty, countryCode: 'de' } }),
    );

    expect(issues).toEqual([
      { path: 'seller.countryCode', code: 'countryCode', blocking: true },
    ]);
  });

  it('blocks a lowercase currency code', () => {
    expect(draftIssues(draftOf({ currency: 'eur' }))).toEqual([
      { path: 'currency', code: 'currency', blocking: true },
    ]);
  });

  it('blocks a non-integer position', () => {
    const draft = draftOf();
    const issues = draftIssues({
      ...draft,
      lineItems: [{ ...draft.lineItems[0]!, position: '0' }],
    });

    expect(issues).toEqual([
      { path: 'lineItems[0].position', code: 'position', blocking: true },
    ]);
  });

  it.each([
    { rate: '0', category: 'S' as const },
    { rate: '-1', category: 'S' as const },
    { rate: '19', category: 'AE' as const },
  ])(
    'blocks VAT category $category combined with rate $rate',
    ({ rate, category }) => {
      const draft = draftOf();
      const issues = draftIssues({
        ...draft,
        vatBreakdown: [{ ...draft.vatBreakdown[0]!, rate, category }],
      });

      expect(issues).toContainEqual({
        path: 'vatBreakdown[0].category',
        code: 'vatCategory',
        blocking: true,
      });
    },
  );

  it('ignores an empty optional field', () => {
    expect(draftIssues(draftOf({ dueDate: null }))).toEqual([]);
  });

  it('accepts a known-valid IBAN, with or without printed spaces', () => {
    expect(
      draftIssues(draftOf({ sellerIban: 'DE89370400440532013000' })),
    ).toEqual([]);
    expect(
      draftIssues(draftOf({ sellerIban: 'DE89 3704 0044 0532 0130 00' })),
    ).toEqual([]);
  });

  it('warns without blocking on an IBAN with a mutated checksum', () => {
    expect(
      draftIssues(draftOf({ sellerIban: 'DE89370400440532013001' })),
    ).toEqual([{ path: 'sellerIban', code: 'ibanChecksum', blocking: false }]);
  });

  it('does not flag an IBAN that is still being typed', () => {
    expect(draftIssues(draftOf({ sellerIban: 'DE89' }))).toEqual([]);
  });

  it('accepts a known-valid German VAT ID', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', vatId: 'DE136695976' },
        }),
      ),
    ).toEqual([]);
  });

  it('blocks a German VAT ID with a mutated check digit', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', vatId: 'DE136695977' },
        }),
      ),
    ).toEqual([
      { path: 'seller.vatId', code: 'vatIdChecksum', blocking: true },
    ]);
  });

  it('blocks an invalid German buyer VAT ID checksum', () => {
    expect(
      draftIssues(
        draftOf({
          buyer: { ...emptyParty, countryCode: 'DE', vatId: 'DE811907981' },
        }),
      ),
    ).toEqual([{ path: 'buyer.vatId', code: 'vatIdChecksum', blocking: true }]);
  });

  it('blocks both VAT IDs required for intra-community supply', () => {
    const draft = draftOf({
      seller: { ...emptyParty, countryCode: 'DE' },
      buyer: { ...emptyParty, countryCode: 'FR' },
      vatBreakdown: [
        {
          rate: '0',
          base: '1190.00',
          amount: '0.00',
          category: 'K',
          exemptionReason: 'Intra-community supply',
        },
      ],
    });

    expect(draftIssues(draft)).toEqual(
      expect.arrayContaining([
        {
          path: 'seller.vatId',
          code: 'vatCategorySellerVatId',
          blocking: true,
        },
        {
          path: 'buyer.vatId',
          code: 'vatCategoryBuyerVatId',
          blocking: true,
        },
      ]),
    );
  });

  it('accepts a lowercase German VAT ID', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', vatId: 'de136695976' },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts a German VAT ID with the spaces it is printed with', () => {
    expect(
      draftIssues(
        draftOf({
          seller: {
            ...emptyParty,
            countryCode: 'DE',
            vatId: 'DE 136 695 976',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('blocks an incomplete German VAT ID before confirmation', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', vatId: 'DE1366' },
        }),
      ),
    ).toEqual([{ path: 'seller.vatId', code: 'vatIdSyntax', blocking: true }]);
  });

  it('leaves a VAT ID from another member state unflagged', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'FR', vatId: 'FR12345678901' },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts a five-digit German postal code', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', postalCode: '10115' },
        }),
      ),
    ).toEqual([]);
  });

  it('warns without blocking on a German postal code that is not five digits', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'DE', postalCode: '1011A' },
        }),
      ),
    ).toEqual([
      { path: 'seller.postalCode', code: 'germanPostalCode', blocking: false },
    ]);
  });

  it('does not check postal code format for a non-German address', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, countryCode: 'FR', postalCode: '1234' },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts a plausible contact email', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, contactEmail: 'rechnung@example.de' },
        }),
      ),
    ).toEqual([]);
  });

  it('warns without blocking on an implausible contact email', () => {
    expect(
      draftIssues(
        draftOf({
          buyer: { ...emptyParty, contactEmail: 'not valid@example.de' },
        }),
      ),
    ).toEqual([
      { path: 'buyer.contactEmail', code: 'emailFormat', blocking: false },
    ]);
  });

  it('does not flag an email still being typed', () => {
    expect(
      draftIssues(
        draftOf({ seller: { ...emptyParty, contactEmail: 'rechnung@ex' } }),
      ),
    ).toEqual([]);
  });

  it('warns without blocking on a contact phone containing letters', () => {
    expect(
      draftIssues(
        draftOf({
          seller: { ...emptyParty, contactPhone: 'call 123456' },
        }),
      ),
    ).toEqual([
      { path: 'seller.contactPhone', code: 'phoneFormat', blocking: false },
    ]);
  });

  it('does not flag a phone number still being typed', () => {
    expect(
      draftIssues(draftOf({ seller: { ...emptyParty, contactPhone: '+49' } })),
    ).toEqual([]);
  });

  it('accepts a known-valid BIC', () => {
    expect(draftIssues(draftOf({ sellerBic: 'DEUTDEFF' }))).toEqual([]);
  });

  it('warns without blocking on a malformed BIC', () => {
    expect(draftIssues(draftOf({ sellerBic: 'DEUTDEFFX' }))).toEqual([
      { path: 'sellerBic', code: 'bicFormat', blocking: false },
    ]);
  });

  it('does not flag a BIC still being typed', () => {
    expect(draftIssues(draftOf({ sellerBic: 'DEUT' }))).toEqual([]);
  });

  it('warns without blocking on a Leitweg-ID-shaped reference with a mutated check digit', () => {
    expect(
      draftIssues(draftOf({ buyerReference: '04011000-1234512345-07' })),
    ).toEqual([
      { path: 'buyerReference', code: 'leitwegIdChecksum', blocking: false },
    ]);
  });

  it('does not check an ordinary purchase-order reference against the Leitweg-ID checksum', () => {
    expect(draftIssues(draftOf({ buyerReference: 'PO-2026-001' }))).toEqual([]);
  });
});

describe('diffDraft', () => {
  it('reports nothing for an untouched draft', () => {
    expect(diffDraft(toDraft(wireData), toDraft(wireData))).toEqual([]);
  });

  it('reports a top-level change with both values', () => {
    expect(
      diffDraft(toDraft(wireData), draftOf({ grossTotal: '1416.20' })),
    ).toEqual([{ path: 'grossTotal', before: '1416.10', after: '1416.20' }]);
  });

  it('reports a filled-in null as a change from nothing', () => {
    expect(
      diffDraft(toDraft(wireData), draftOf({ buyerReference: '991-12345-67' })),
    ).toEqual([
      { path: 'buyerReference', before: null, after: '991-12345-67' },
    ]);
  });

  it('reaches into line items and parties', () => {
    const draft = draftOf();
    const changed: InvoiceDraft = {
      ...draft,
      seller: { ...draft.seller, city: 'Berlin' },
      lineItems: [{ ...draft.lineItems[0]!, netAmount: '1200.00' }],
    };

    expect(diffDraft(draft, changed).map((change) => change.path)).toEqual([
      'lineItems[0].netAmount',
      'seller.city',
    ]);
  });

  it('reports a removed line item', () => {
    const draft = draftOf();
    const changes = diffDraft(draft, { ...draft, lineItems: [] });

    expect(changes.every((change) => change.after === null)).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
  });
});
