import { GoldenFixtureSchema } from './golden-fixture.schema';

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

const emptyInvoice = {
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
};

describe('GoldenFixtureSchema', () => {
  it('rejects an OCR fixture that omits its scan quality', () => {
    const fixture = {
      meta: {
        id: '011-scan-clean-de',
        language: 'de' as const,
        sourceType: 'ocr' as const,
        content: 'invoice' as const,
        pages: 1,
        expectedOutcome: 'success' as const,
        expectedErrors: [],
        notes: 'A clean scan',
      },
      data: emptyInvoice,
    };

    const result = GoldenFixtureSchema.safeParse(fixture);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected fixture rejection');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['meta', 'scanQuality'],
          message: 'OCR fixtures must declare scanQuality',
        }),
      ]),
    );
  });

  it('rejects a fixture that does not say whether it depicts an invoice', () => {
    const fixture = {
      meta: {
        id: '001-valid-de',
        language: 'de' as const,
        sourceType: 'native' as const,
        pages: 1,
        expectedOutcome: 'success' as const,
        expectedErrors: [],
        notes: 'A native-text invoice',
      },
      data: emptyInvoice,
    };

    const result = GoldenFixtureSchema.safeParse(fixture);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected fixture rejection');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['meta', 'content'] }),
      ]),
    );
  });

  it('rejects a native fixture that declares scan quality', () => {
    const fixture = {
      meta: {
        id: '001-valid-de',
        language: 'de' as const,
        sourceType: 'native' as const,
        content: 'invoice' as const,
        scanQuality: 'clean' as const,
        pages: 1,
        expectedOutcome: 'success' as const,
        expectedErrors: [],
        notes: 'A native-text invoice',
      },
      data: emptyInvoice,
    };

    const result = GoldenFixtureSchema.safeParse(fixture);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected fixture rejection');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['meta', 'scanQuality'],
          message: 'Only OCR fixtures may declare scanQuality',
        }),
      ]),
    );
  });
});
