import { buildValidRawExtractedInvoiceData } from '../data-extraction/raw-extracted-invoice.fixture';
import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';
import { mapToXRechnungInvoice } from './xrechnung-mapper';

function validData(
  overrides: Partial<RawExtractedInvoiceData> = {},
): RawExtractedInvoiceData {
  return { ...buildValidRawExtractedInvoiceData(), ...overrides };
}

function firstLineItem(
  invoice: RawExtractedInvoiceData,
): RawExtractedInvoiceData['lineItems'][number] {
  const lineItem = invoice.lineItems[0];
  if (!lineItem) {
    throw new Error('Expected a line item');
  }
  return lineItem;
}

function firstVatBreakdown(
  invoice: RawExtractedInvoiceData,
): RawExtractedInvoiceData['vatBreakdown'][number] {
  const vatBreakdown = invoice.vatBreakdown[0];
  if (!vatBreakdown) {
    throw new Error('Expected a VAT breakdown');
  }
  return vatBreakdown;
}

describe('mapToXRechnungInvoice', () => {
  it('maps a complete invoice to the XRechnung UBL invoice shape', () => {
    const mapped = mapToXRechnungInvoice(validData());

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const invoice = mapped.invoice['ubl:Invoice'];
    const line = invoice['cac:InvoiceLine'][0];
    const taxTotal = invoice['cac:TaxTotal'][0];
    const paymentMeans = invoice['cac:PaymentMeans']?.[0];

    expect(invoice['cbc:ID']).toBe('RE-2026-001');
    expect(invoice['cbc:InvoiceTypeCode']).toBe('380');
    expect(invoice['cbc:DocumentCurrencyCode']).toBe('EUR');
    expect(
      invoice['cac:AccountingSupplierParty']['cac:Party'][
        'cbc:EndpointID@schemeID'
      ],
    ).toBe('0204');
    expect(invoice['cac:InvoiceLine']).toHaveLength(1);
    expect(line['cbc:InvoicedQuantity@unitCode']).toBe('C62');
    expect(line['cac:Item']['cac:ClassifiedTaxCategory']['cbc:ID']).toBe('S');
    expect(taxTotal['cac:TaxSubtotal']).toHaveLength(1);
    expect(invoice['cac:LegalMonetaryTotal']['cbc:PayableAmount']).toBe(
      '119.00',
    );
    expect(paymentMeans?.['cbc:PaymentMeansCode']).toBe('58');
  });

  it('maps the delivery date and the seller BIC when the invoice printed them', () => {
    const mapped = mapToXRechnungInvoice(
      validData({ deliveryDate: '2026-08-24', sellerBic: 'DEUTDEFF' }),
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const invoice = mapped.invoice['ubl:Invoice'];

    expect(invoice['cac:Delivery']?.['cbc:ActualDeliveryDate']).toBe(
      '2026-08-24',
    );
    expect(
      invoice['cac:PaymentMeans']?.[0]?.['cac:PayeeFinancialAccount']?.[
        'cac:FinancialInstitutionBranch'
      ]?.['cbc:ID'],
    ).toBe('DEUTDEFF');
  });

  it('omits delivery and the financial institution branch when neither was printed', () => {
    const mapped = mapToXRechnungInvoice(
      validData({ deliveryDate: null, sellerBic: null }),
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const invoice = mapped.invoice['ubl:Invoice'];

    expect(invoice['cac:Delivery']).toBeUndefined();
    expect(
      invoice['cac:PaymentMeans']?.[0]?.['cac:PayeeFinancialAccount']?.[
        'cac:FinancialInstitutionBranch'
      ],
    ).toBeUndefined();
  });

  it('normalizes amounts with fewer than two decimals to exactly two', () => {
    const data = validData({ netTotal: '119', grossTotal: '119.5' });

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const totals = mapped.invoice['ubl:Invoice']['cac:LegalMonetaryTotal'];
    expect(totals['cbc:LineExtensionAmount']).toBe('119.00');
    expect(totals['cbc:PayableAmount']).toBe('119.50');
  });

  it('rejects a line item with no unit printed on the invoice', () => {
    const data = validData();
    firstLineItem(data).unit = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toEqual([
      expect.objectContaining({
        rule: 'mapping.line_unit',
        field: 'lineItems[0].unit',
        passed: false,
      }),
    ]);
  });

  it('maps the English printed unit "hours" to HUR', () => {
    const data = validData();
    firstLineItem(data).unit = 'hours';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const line = mapped.invoice['ubl:Invoice']['cac:InvoiceLine'][0];
    expect(line['cbc:InvoicedQuantity@unitCode']).toBe('HUR');
  });

  it('rejects a printed unit with no known XRechnung unit code', () => {
    const data = validData();
    firstLineItem(data).unit = 'Sack';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toEqual([
      expect.objectContaining({
        rule: 'mapping.line_unit',
        field: 'lineItems[0].unit',
        passed: false,
      }),
    ]);
  });

  it('rejects a zero VAT rate as insufficient evidence for a category', () => {
    const data = validData({
      netTotal: '100.00',
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    const lineItem = firstLineItem(data);
    lineItem.vatRate = '0';
    lineItem.vatExemptionReason = 'innergemeinschaftliche Lieferung';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.exemptionReason = 'innergemeinschaftliche Lieferung';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    const rules = mapped.findings.map((finding) => finding.rule).sort();
    expect(rules).toEqual([
      'mapping.line_vat_category',
      'mapping.vat_breakdown_category',
    ]);
  });

  it('rejects a negative VAT rate', () => {
    const data = validData();
    firstLineItem(data).vatRate = '-19';
    firstVatBreakdown(data).rate = '-19';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    const rules = mapped.findings.map((finding) => finding.rule).sort();
    expect(rules).toEqual([
      'mapping.line_vat_category',
      'mapping.vat_breakdown_category',
    ]);
  });

  it('maps a reverse-charge (AE) VAT breakdown with the implied exemption reason code', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'AE';
    vatBreakdown.exemptionReason = 'Reverse charge';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const invoice = mapped.invoice['ubl:Invoice'];
    const taxCategory =
      invoice['cac:TaxTotal'][0]['cac:TaxSubtotal']?.[0]?.['cac:TaxCategory'];
    expect(taxCategory?.['cbc:ID']).toBe('AE');
    expect(taxCategory?.['cbc:TaxExemptionReasonCode']).toBe('VATEX-EU-AE');
    expect(taxCategory?.['cbc:TaxExemptionReason']).toBeUndefined();
    const line = invoice['cac:InvoiceLine'][0];
    expect(line['cac:Item']['cac:ClassifiedTaxCategory']['cbc:ID']).toBe('AE');
  });

  it('maps an exempt (E) VAT breakdown with the free-text exemption reason', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'E';
    vatBreakdown.exemptionReason = 'Kleinunternehmerregelung nach § 19 UStG';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const taxCategory =
      mapped.invoice['ubl:Invoice']['cac:TaxTotal'][0][
        'cac:TaxSubtotal'
      ]?.[0]?.['cac:TaxCategory'];
    expect(taxCategory?.['cbc:ID']).toBe('E');
    expect(taxCategory?.['cbc:TaxExemptionReasonCode']).toBeUndefined();
    expect(taxCategory?.['cbc:TaxExemptionReason']).toBe(
      'Kleinunternehmerregelung nach § 19 UStG',
    );
  });

  it('rejects an exempt (E) VAT breakdown with no free-text exemption reason', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'E';
    vatBreakdown.exemptionReason = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({
        rule: 'mapping.vat_breakdown_category',
        field: 'vatBreakdown[0].exemptionReason',
        passed: false,
      }),
    );
  });

  it('maps a zero-rated (Z) VAT breakdown with no exemption reason code or text', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'Z';
    vatBreakdown.exemptionReason = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const taxCategory =
      mapped.invoice['ubl:Invoice']['cac:TaxTotal'][0][
        'cac:TaxSubtotal'
      ]?.[0]?.['cac:TaxCategory'];
    expect(taxCategory?.['cbc:ID']).toBe('Z');
    expect(taxCategory?.['cbc:TaxExemptionReasonCode']).toBeUndefined();
    expect(taxCategory?.['cbc:TaxExemptionReason']).toBeUndefined();
  });

  it('maps an intra-community supply (K) with a full deliver-to address from the buyer, per BR-DE-10/-11', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    data.buyer.countryCode = 'FR';
    data.buyer.vatId = 'FR40303265045';
    data.buyer.city = 'Paris';
    data.buyer.postalCode = '75001';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'K';
    vatBreakdown.exemptionReason = 'Intra-community supply';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const invoice = mapped.invoice['ubl:Invoice'];
    const deliveryAddress =
      invoice['cac:Delivery']?.['cac:DeliveryLocation']?.['cac:Address'];
    expect(deliveryAddress?.['cac:Country']?.['cbc:IdentificationCode']).toBe(
      'FR',
    );
    expect(deliveryAddress?.['cbc:CityName']).toBe('Paris');
    expect(deliveryAddress?.['cbc:PostalZone']).toBe('75001');
    const taxCategory =
      invoice['cac:TaxTotal'][0]['cac:TaxSubtotal']?.[0]?.['cac:TaxCategory'];
    expect(taxCategory?.['cbc:TaxExemptionReasonCode']).toBe('VATEX-EU-IC');
  });

  it('omits the delivery location when no breakdown row uses category K', () => {
    const data = validData({ deliveryDate: null });

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.invoice['ubl:Invoice']['cac:Delivery']).toBeUndefined();
  });

  it('rejects a non-zero VAT rate combined with a non-standard VAT category', () => {
    const data = validData();
    firstVatBreakdown(data).category = 'AE';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({
        rule: 'mapping.vat_breakdown_category',
        field: 'vatBreakdown[0].rate',
        passed: false,
      }),
    );
  });

  it('derives a line item VAT category from the one matching VAT breakdown row', () => {
    const data = validData({
      vatTotal: '0.00',
      grossTotal: '100.00',
    });
    firstLineItem(data).vatRate = '0';
    const vatBreakdown = firstVatBreakdown(data);
    vatBreakdown.rate = '0';
    vatBreakdown.amount = '0.00';
    vatBreakdown.category = 'G';
    vatBreakdown.exemptionReason = 'Export outside the EU';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const line = mapped.invoice['ubl:Invoice']['cac:InvoiceLine'][0];
    expect(line['cac:Item']['cac:ClassifiedTaxCategory']['cbc:ID']).toBe('G');
  });

  it('rejects an ambiguous line item VAT rate matched by breakdown rows with different categories', () => {
    const data = validData({
      netTotal: '200.00',
      vatTotal: '0.00',
      grossTotal: '200.00',
      lineItems: [
        { ...firstLineItem(validData()), vatRate: '0', netAmount: '100.00' },
        {
          ...firstLineItem(validData()),
          position: 2,
          netAmount: '100.00',
          vatRate: '0',
        },
      ],
      vatBreakdown: [
        {
          rate: '0',
          base: '100.00',
          amount: '0.00',
          category: 'AE',
          exemptionReason: 'Reverse charge',
        },
        {
          rate: '0',
          base: '100.00',
          amount: '0.00',
          category: 'Z',
          exemptionReason: null,
        },
      ],
    });

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({
        rule: 'mapping.line_vat_category',
        field: 'lineItems[0].vatRate',
        passed: false,
      }),
    );
  });

  it('rejects a currency the XRechnung UBL profile does not support', () => {
    const data = validData();
    data.currency = 'ZZZ';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({ rule: 'mapping.currency', field: 'currency' }),
    );
  });

  it('rejects a seller identified only by Steuernummer, not VAT ID', () => {
    const data = validData();
    data.seller.vatId = null;
    data.seller.taxNumber = '30/815/08150';

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({
        rule: 'mapping.seller_tax_id',
        field: 'seller.vatId',
      }),
    );
  });

  it('maps a buyer without a VAT ID by omitting its tax scheme', () => {
    const data = validData();
    data.buyer.vatId = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(
      mapped.invoice['ubl:Invoice']['cac:AccountingCustomerParty']['cac:Party'][
        'cac:PartyTaxScheme'
      ],
    ).toBeUndefined();
  });

  it('maps a party without a street', () => {
    const data = validData();
    data.seller.street = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(
      mapped.invoice['ubl:Invoice']['cac:AccountingSupplierParty']['cac:Party'][
        'cac:PostalAddress'
      ]['cbc:StreetName'],
    ).toBeUndefined();
  });

  it('collects findings from independent problems in one pass', () => {
    const data = validData();
    firstLineItem(data).unit = 'Sack';
    data.currency = 'ZZZ';
    data.seller.vatId = null;
    data.seller.taxNumber = null;

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    const rules = mapped.findings.map((finding) => finding.rule).sort();
    expect(rules).toEqual(
      ['mapping.currency', 'mapping.line_unit', 'mapping.seller_tax_id'].sort(),
    );
  });

  it.each<[string, string, (data: RawExtractedInvoiceData) => void]>([
    [
      'mapping.invoice_header',
      'buyerReference',
      (data) => {
        data.buyerReference = null;
      },
    ],
    [
      'mapping.party_address',
      'seller.name',
      (data) => {
        data.seller.name = null;
      },
    ],
    [
      'mapping.party_country_code',
      'seller.countryCode',
      (data) => {
        data.seller.countryCode = 'ZZ';
      },
    ],
    [
      'mapping.electronic_address',
      'seller.electronicAddress',
      (data) => {
        data.seller.electronicAddress = null;
      },
    ],
    [
      'mapping.electronic_address_scheme',
      'seller.electronicAddressScheme',
      (data) => {
        data.seller.electronicAddressScheme = '9999';
      },
    ],
    [
      'mapping.electronic_address_scheme',
      'seller.electronicAddressScheme',
      (data) => {
        data.seller.electronicAddressScheme = '0245';
      },
    ],
    [
      'mapping.currency',
      'currency',
      (data) => {
        data.currency = 'STN';
      },
    ],
    [
      'mapping.line_item',
      'lineItems[0].description',
      (data) => {
        firstLineItem(data).description = null;
      },
    ],
    [
      'mapping.line_item',
      'lineItems',
      (data) => {
        data.lineItems = [];
      },
    ],
    [
      'mapping.vat_breakdown',
      'vatBreakdown[0].base',
      (data) => {
        firstVatBreakdown(data).base = null;
      },
    ],
    [
      'mapping.vat_breakdown',
      'vatBreakdown',
      (data) => {
        data.vatBreakdown = [];
      },
    ],
    [
      'mapping.amount_precision',
      'netTotal',
      (data) => {
        data.netTotal = '100.005';
      },
    ],
  ])('rejects with rule %s on field %s', (rule, field, mutate) => {
    const data = validData();
    mutate(data);

    const mapped = mapToXRechnungInvoice(data);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.findings).toEqual([expect.objectContaining({ rule, field })]);
  });
});
