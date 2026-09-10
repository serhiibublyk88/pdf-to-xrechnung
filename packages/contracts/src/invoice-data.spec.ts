import {
  MAX_LINE_ITEMS,
  MAX_TEXT_LENGTH,
  MAX_VAT_BREAKDOWNS,
  RawExtractedInvoiceDataSchema,
  type RawExtractedInvoiceData,
  type LineItem,
  type VatBreakdown,
} from './invoice-data';

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

function emptyLineItem(): LineItem {
  return {
    position: null,
    description: null,
    quantity: null,
    unit: null,
    unitPrice: null,
    netAmount: null,
    vatRate: null,
    vatExemptionReason: null,
  };
}

function emptyVatBreakdown(): VatBreakdown {
  return {
    rate: null,
    base: null,
    amount: null,
    category: null,
    exemptionReason: null,
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

describe('RawExtractedInvoiceDataSchema', () => {
  it('accepts a fully-null response', () => {
    expect(RawExtractedInvoiceDataSchema.safeParse(emptyData()).success).toBe(
      true,
    );
  });

  it('rejects an omitted key the model should have sent as null', () => {
    const withoutSeller: Record<string, unknown> = emptyData();
    delete withoutSeller.seller;
    expect(RawExtractedInvoiceDataSchema.safeParse(withoutSeller).success).toBe(
      false,
    );
  });

  it('rejects a non-canonical decimal string', () => {
    const data = { ...emptyData(), netTotal: '1.234,56' };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('accepts correction collections and text exactly at their product limits', () => {
    const data = {
      ...emptyData(),
      invoiceNumber: 'A'.repeat(MAX_TEXT_LENGTH),
      lineItems: Array.from({ length: MAX_LINE_ITEMS }, () => emptyLineItem()),
      vatBreakdown: Array.from({ length: MAX_VAT_BREAKDOWNS }, () =>
        emptyVatBreakdown(),
      ),
    };

    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(true);
  });

  it('rejects correction collections and text one beyond their product limits', () => {
    const lineItems = Array.from({ length: MAX_LINE_ITEMS + 1 }, () =>
      emptyLineItem(),
    );
    const vatBreakdown = Array.from({ length: MAX_VAT_BREAKDOWNS + 1 }, () =>
      emptyVatBreakdown(),
    );

    expect(
      RawExtractedInvoiceDataSchema.safeParse({
        ...emptyData(),
        lineItems,
      }).success,
    ).toBe(false);
    expect(
      RawExtractedInvoiceDataSchema.safeParse({
        ...emptyData(),
        vatBreakdown,
      }).success,
    ).toBe(false);
    expect(
      RawExtractedInvoiceDataSchema.safeParse({
        ...emptyData(),
        invoiceNumber: 'A'.repeat(MAX_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown key', () => {
    const data = { ...emptyData(), unexpectedField: 'x' };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('rejects an unknown key nested inside a party', () => {
    const data = emptyData();
    const seller: Record<string, unknown> = { ...data.seller, iban: null };
    expect(
      RawExtractedInvoiceDataSchema.safeParse({ ...data, seller }).success,
    ).toBe(false);
  });

  it('rejects a free-text field carrying a character illegal in XML 1.0', () => {
    const data = {
      ...emptyData(),
      invoiceNumber: `RE-2026-001${String.fromCharCode(0x07)}`,
    };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('rejects a lone surrogate in a free-text field', () => {
    const data = { ...emptyData(), paymentTerms: String.fromCharCode(0xd800) };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('accepts tab, newline, and carriage return in a free-text field', () => {
    const data = {
      ...emptyData(),
      paymentTerms: 'Net 30\tdays\nper contract\r\n',
    };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(true);
  });

  it('accepts a properly paired surrogate (an astral character) in a free-text field', () => {
    const data = { ...emptyData(), buyerReference: 'Order 😀 #1' };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(true);
  });
  it.each([
    ['de136695976', 'DE136695976'],
    ['DE 136 695 976', 'DE136695976'],
    ['  de 136 695 976  ', 'DE136695976'],
  ])('normalises a VAT ID printed as %s', (printed, expected) => {
    const parsed = RawExtractedInvoiceDataSchema.safeParse({
      ...emptyData(),
      seller: { ...emptyData().seller, vatId: printed },
    });

    expect(parsed.success && parsed.data.seller.vatId).toBe(expected);
  });

  it('leaves an absent VAT ID null', () => {
    const parsed = RawExtractedInvoiceDataSchema.safeParse(emptyData());

    expect(parsed.success && parsed.data.seller.vatId).toBeNull();
  });

  it.each([
    ['2026-02-28', true],
    ['2026-02-31', true],
    ['28.02.2026', false],
    ['2026/02/28', false],
    ['26-02-28', false],
  ])(
    'checks issueDate %s against the ISO shape only, not the calendar',
    (value, expected) => {
      const data = { ...emptyData(), issueDate: value };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(
        expected,
      );
    },
  );

  it.each([
    ['EUR', true],
    ['eur', false],
    ['EU', false],
    ['EURO', false],
  ])(
    'accepts currency %s only as three uppercase ASCII letters',
    (value, expected) => {
      const data = { ...emptyData(), currency: value };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(
        expected,
      );
    },
  );

  it('rejects a currency sent as a JSON number', () => {
    const data = { ...emptyData(), currency: 978 };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('accepts the XRechnung-specific 1A country code', () => {
    const data = {
      ...emptyData(),
      seller: { ...emptyData().seller, countryCode: '1A' },
    };

    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(true);
  });

  it.each([
    ['DE', true],
    ['de', false],
    ['D', false],
    ['DEU', false],
  ])(
    'accepts seller country %s only as two uppercase ASCII letters',
    (value, expected) => {
      const data = {
        ...emptyData(),
        seller: { ...emptyData().seller, countryCode: value },
      };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(
        expected,
      );
    },
  );

  it('rejects a country code sent as a JSON number', () => {
    const data = {
      ...emptyData(),
      seller: { ...emptyData().seller, countryCode: 49 },
    };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it.each([
    [1, true],
    [null, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
  ])(
    'accepts line item position %s only as a positive safe integer or null',
    (value, expected) => {
      const data = {
        ...emptyData(),
        lineItems: [{ ...emptyLineItem(), position: value }],
      };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(
        expected,
      );
    },
  );

  it('rejects a position sent as a string', () => {
    const data = {
      ...emptyData(),
      lineItems: [{ ...emptyLineItem(), position: '1' }],
    };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('rejects an unknown key inside a line item', () => {
    const lineItem: Record<string, unknown> = { ...emptyLineItem(), sku: 'x' };
    const data = { ...emptyData(), lineItems: [lineItem] };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it('rejects an unknown key inside a VAT breakdown entry', () => {
    const vatBreakdown: Record<string, unknown> = {
      ...emptyVatBreakdown(),
      note: 'x',
    };
    const data = { ...emptyData(), vatBreakdown: [vatBreakdown] };
    expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
  });

  it.each(Object.keys(emptyParty()))(
    'rejects a party omitting the required key %s',
    (key) => {
      const seller: Record<string, unknown> = emptyParty();
      delete seller[key];
      const data = { ...emptyData(), seller };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
    },
  );

  it.each(Object.keys(emptyLineItem()))(
    'rejects a line item omitting the required key %s',
    (key) => {
      const lineItem: Record<string, unknown> = emptyLineItem();
      delete lineItem[key];
      const data = { ...emptyData(), lineItems: [lineItem] };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
    },
  );

  it.each(Object.keys(emptyVatBreakdown()).filter((key) => key !== 'category'))(
    'rejects a VAT breakdown entry omitting the required key %s',
    (key) => {
      const vatBreakdown: Record<string, unknown> = emptyVatBreakdown();
      delete vatBreakdown[key];
      const data = { ...emptyData(), vatBreakdown: [vatBreakdown] };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
    },
  );

  it('defaults an omitted VAT breakdown category to null, since the model is never asked for it', () => {
    const vatBreakdown: Record<string, unknown> = emptyVatBreakdown();
    delete vatBreakdown.category;
    const data = { ...emptyData(), vatBreakdown: [vatBreakdown] };

    const parsed = RawExtractedInvoiceDataSchema.safeParse(data);

    expect(parsed.success && parsed.data.vatBreakdown[0]?.category).toBeNull();
  });

  it.each(['S', 'AE', 'K', 'G', 'E', 'Z'])(
    'accepts the offered VAT category code %s',
    (category) => {
      const data = {
        ...emptyData(),
        vatBreakdown: [{ ...emptyVatBreakdown(), category }],
      };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(true);
    },
  );

  it.each(['O', 'L', 'M', 'B'])(
    'rejects a VAT category outside the offered closed list: %s',
    (category) => {
      const data = {
        ...emptyData(),
        vatBreakdown: [{ ...emptyVatBreakdown(), category }],
      };
      expect(RawExtractedInvoiceDataSchema.safeParse(data).success).toBe(false);
    },
  );
});
