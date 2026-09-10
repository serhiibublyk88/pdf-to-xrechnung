import { InvoiceStatus, Severity } from '@prisma/client';
import { buildValidRawExtractedInvoiceData } from '../data-extraction/raw-extracted-invoice.fixture';
import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';
import {
  reviewRoutingStatus,
  type ValidationFinding,
  validateExtractedInvoice,
} from './invoice-validator';

const VALIDATION_DATE = new Date('2026-08-10T00:00:00.000Z');

function validInvoice(): RawExtractedInvoiceData {
  return {
    ...buildValidRawExtractedInvoiceData(),
    issueDate: '2026-08-10',
    dueDate: '2026-09-09',
    deliveryDate: '2026-08-09',
  };
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

function findingFor(
  findings: ValidationFinding[],
  rule: string,
  field?: string,
): ValidationFinding {
  const finding = findings.find(
    (candidate) =>
      candidate.rule === rule &&
      (field === undefined || candidate.field === field),
  );
  if (!finding) {
    throw new Error(`Expected validation finding for ${rule}`);
  }
  return finding;
}

describe('validateExtractedInvoice', () => {
  it('accepts a complete invoice whose arithmetic, formats, and required XRechnung fields agree', () => {
    const findings = validateExtractedInvoice(validInvoice(), VALIDATION_DATE);

    expect(
      findings.filter(
        (finding) => !finding.passed && finding.severity === Severity.ERROR,
      ),
    ).toEqual([]);
    expect(findingFor(findings, 'arithmetic.gross')).toEqual(
      expect.objectContaining({
        passed: true,
        expected: '119.00',
        actual: '119.00',
      }),
    );
  });

  it('flags a corrupted gross total as an error with the expected and printed values', () => {
    const invoice = validInvoice();
    invoice.grossTotal = '120.00';

    const finding = findingFor(
      validateExtractedInvoice(invoice, VALIDATION_DATE),
      'arithmetic.gross',
      'grossTotal',
    );

    expect(finding).toEqual({
      rule: 'arithmetic.gross',
      field: 'grossTotal',
      severity: Severity.ERROR,
      passed: false,
      message: 'Gross total does not match the expected amount.',
      expected: '119.00',
      actual: '120.00',
    });
  });

  it.each([
    {
      rule: 'arithmetic.line_net',
      field: 'lineItems[0].netAmount',
      change: (invoice: RawExtractedInvoiceData) => {
        invoice.lineItems[0] = {
          ...firstLineItem(invoice),
          netAmount: '100.02',
        };
      },
    },
    {
      rule: 'arithmetic.line_sum',
      field: 'netTotal',
      change: (invoice: RawExtractedInvoiceData) => {
        invoice.netTotal = '102.00';
        invoice.vatBreakdown[0] = {
          ...firstVatBreakdown(invoice),
          base: '102.00',
          amount: '19.38',
        };
        invoice.vatTotal = '19.38';
        invoice.grossTotal = '121.38';
      },
    },
    {
      rule: 'arithmetic.vat_base_sum',
      field: 'netTotal',
      change: (invoice: RawExtractedInvoiceData) => {
        invoice.vatBreakdown[0] = {
          ...firstVatBreakdown(invoice),
          base: '101.00',
          amount: '19.19',
        };
        invoice.vatTotal = '19.19';
        invoice.grossTotal = '119.19';
      },
    },
    {
      rule: 'arithmetic.vat_amount',
      field: 'vatBreakdown[0].amount',
      change: (invoice: RawExtractedInvoiceData) => {
        invoice.vatBreakdown[0] = {
          ...firstVatBreakdown(invoice),
          amount: '19.02',
        };
        invoice.vatTotal = '19.02';
        invoice.grossTotal = '119.02';
      },
    },
    {
      rule: 'arithmetic.vat_total',
      field: 'vatTotal',
      change: (invoice: RawExtractedInvoiceData) => {
        invoice.lineItems.push({
          position: 2,
          description: 'Second service',
          quantity: '1',
          unit: 'C62',
          unitPrice: '0.00',
          netAmount: '0.00',
          vatRate: '7',
          vatExemptionReason: null,
        });
        invoice.vatBreakdown.push({
          rate: '7',
          base: '0.00',
          amount: '0.00',
          category: null,
          exemptionReason: null,
        });
        invoice.vatTotal = '19.02';
        invoice.grossTotal = '119.02';
      },
    },
  ])('flags an independent $rule mismatch', ({ rule, field, change }) => {
    const invoice = validInvoice();
    change(invoice);

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        rule,
        field,
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('rounds a fractional-cent line amount once, half away from zero', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = {
      ...firstLineItem(invoice),
      quantity: '3',
      unitPrice: '0.005',
      netAmount: '0.02',
    };
    invoice.netTotal = '0.02';
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      base: '0.02',
      amount: '0.00',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '0.02';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'arithmetic.line_net',
        'lineItems[0].netAmount',
      ),
    ).toEqual(expect.objectContaining({ passed: true, expected: '0.02' }));
  });

  it('rejects a printed total with more than two decimal places instead of rounding it', () => {
    const invoice = validInvoice();
    invoice.netTotal = '100.001';

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(
      findingFor(findings, 'format.monetary_precision', 'netTotal'),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
    expect(findingFor(findings, 'arithmetic.gross', 'grossTotal')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it.each(['DE136695976', 'DE811907980', 'DE129273398'])(
    'accepts the known-valid German VAT ID %s',
    (vatId) => {
      const invoice = validInvoice();
      invoice.seller.vatId = vatId;

      expect(
        findingFor(
          validateExtractedInvoice(invoice, VALIDATION_DATE),
          'format.vat_id_checksum',
          'seller.vatId',
        ),
      ).toEqual(expect.objectContaining({ passed: true }));
    },
  );

  it('rejects a German VAT ID with a mutated check digit', () => {
    const invoice = validInvoice();
    invoice.seller.vatId = 'DE136695977';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.vat_id_checksum',
        'seller.vatId',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('validates a lowercase German VAT ID against the checksum rule and allowed-prefix rule', () => {
    const invoice = validInvoice();
    invoice.seller.vatId = 'de136695976';

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(
      findingFor(findings, 'format.vat_id_checksum', 'seller.vatId'),
    ).toEqual(expect.objectContaining({ passed: true }));
    expect(
      findingFor(findings, 'format.vat_id_prefix', 'seller.vatId'),
    ).toEqual(expect.objectContaining({ passed: true }));
  });

  it('validates the German VAT ID checksum after removing printed spaces', () => {
    const invoice = validInvoice();
    invoice.seller.vatId = 'DE 136 695 976';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.vat_id_checksum',
        'seller.vatId',
      ),
    ).toEqual(expect.objectContaining({ passed: true }));
  });

  it('validates the IBAN checksum after removing printed spaces', () => {
    const invoice = validInvoice();
    invoice.sellerIban = 'DE89 3704 0044 0532 0130 00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.iban_checksum',
        'sellerIban',
      ),
    ).toEqual(expect.objectContaining({ passed: true }));
  });

  it('blocks an invalid IBAN checksum', () => {
    const invoice = validInvoice();
    invoice.sellerIban = 'DE89370400440532013001';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.iban_checksum',
        'sellerIban',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('warns about a contact email with an implausible format, without blocking', () => {
    const invoice = validInvoice();
    invoice.seller.contactEmail = 'not-an-email';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.email',
        'seller.contactEmail',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('warns about a contact phone with letters in it, without blocking', () => {
    const invoice = validInvoice();
    invoice.buyer.contactPhone = 'call me maybe';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.phone',
        'buyer.contactPhone',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('warns about a malformed BIC, without blocking', () => {
    const invoice = validInvoice();
    invoice.sellerBic = 'DEUTDEFFX';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.bic',
        'sellerBic',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('accepts a known-valid BIC', () => {
    const invoice = validInvoice();
    invoice.sellerBic = 'DEUTDEFF';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.bic',
        'sellerBic',
      ),
    ).toEqual(expect.objectContaining({ passed: true }));
  });

  it('warns about a Leitweg-ID-shaped buyer reference with a mutated check digit', () => {
    const invoice = validInvoice();
    invoice.buyerReference = '04011000-1234512345-07';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.leitweg_id_checksum',
        'buyerReference',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('never evaluates the Leitweg-ID checksum for an ordinary purchase-order reference', () => {
    const invoice = validInvoice();
    invoice.buyerReference = 'PO-2026-001';

    expect(
      validateExtractedInvoice(invoice, VALIDATION_DATE).some(
        (finding) => finding.rule === 'format.leitweg_id_checksum',
      ),
    ).toBe(false);
  });

  it('blocks missing buyer identity on a small-amount invoice, which XRechnung does not exempt', () => {
    const invoice = validInvoice();
    invoice.buyer = {
      ...invoice.buyer,
      name: null,
      street: null,
      postalCode: null,
      city: null,
      countryCode: null,
    };
    invoice.lineItems[0] = {
      ...firstLineItem(invoice),
      unitPrice: '100.00',
      netAmount: '100.00',
    };
    invoice.netTotal = '100.00';
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      base: '100.00',
      amount: '0.00',
      rate: '0',
      exemptionReason: 'Small business exemption',
    };
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.buyer_identity',
        'buyer.name',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('warns about a missing street without blocking', () => {
    const invoice = validInvoice();
    invoice.buyer = { ...invoice.buyer, street: null };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(
      findingFor(findings, 'mandatory.party_street', 'buyer.street'),
    ).toEqual({
      rule: 'mandatory.party_street',
      field: 'buyer.street',
      severity: Severity.WARNING,
      passed: false,
      message: 'Buyer street address is missing.',
    });
    expect(
      findingFor(findings, 'mandatory.buyer_identity', 'buyer.name'),
    ).toEqual(expect.objectContaining({ passed: true }));
    expect(
      findings.filter(
        (finding) => !finding.passed && finding.severity === Severity.ERROR,
      ),
    ).toEqual([]);
  });

  it('warns when a zero VAT rate has no exemption reason', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'plausible.zero_vat_reason',
        'vatBreakdown[0].exemptionReason',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('blocks a zero VAT rate with no VAT category', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      exemptionReason: 'Reverse charge',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category',
        'vatBreakdown[0].category',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('blocks the standard-rated VAT category combined with a zero rate', () => {
    const invoice = validInvoice();
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      category: 'S',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = invoice.netTotal;

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category',
        'vatBreakdown[0].category',
      ),
    ).toEqual(
      expect.objectContaining({
        passed: false,
        message: 'VAT category "S" requires a positive VAT rate.',
      }),
    );
  });

  it('blocks the standard-rated VAT category combined with a negative rate', () => {
    const invoice = validInvoice();
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '-1',
      amount: '-1.00',
      category: 'S',
    };
    invoice.vatTotal = '-1.00';
    invoice.grossTotal = '99.00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category',
        'vatBreakdown[0].category',
      ),
    ).toEqual(
      expect.objectContaining({
        passed: false,
        message: 'VAT category "S" requires a positive VAT rate.',
      }),
    );
  });

  it('blocks a non-standard VAT category combined with a non-zero rate', () => {
    const invoice = validInvoice();
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      category: 'AE',
    };

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category',
        'vatBreakdown[0].category',
      ),
    ).toEqual(
      expect.objectContaining({
        passed: false,
        severity: Severity.ERROR,
        message: 'VAT category "AE" requires a zero VAT rate.',
      }),
    );
  });

  it('blocks a § 4 UStG exemption (category E) with no free-text reason', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      category: 'E',
      exemptionReason: null,
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category_reason',
        'vatBreakdown[0].exemptionReason',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('accepts a zero-rated (category Z) VAT breakdown with no exemption reason', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      category: 'Z',
      exemptionReason: null,
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(
      findingFor(
        findings,
        'mandatory.vat_category',
        'vatBreakdown[0].category',
      ),
    ).toEqual(expect.objectContaining({ passed: true }));
    expect(
      findings.find(
        (finding) => finding.rule === 'mandatory.vat_category_reason',
      ),
    ).toBeUndefined();
  });

  it('requires a buyer VAT ID for the reverse-charge (AE) category', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      category: 'AE',
      exemptionReason: 'Reverse charge',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';
    invoice.buyer = { ...invoice.buyer, vatId: null };

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'mandatory.vat_category_buyer_identity',
        'buyer.vatId',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('accepts a complete reverse-charge invoice with a category and a buyer VAT ID', () => {
    const invoice = validInvoice();
    invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: '0',
      amount: '0.00',
      category: 'AE',
      exemptionReason: 'Reverse charge',
    };
    invoice.vatTotal = '0.00';
    invoice.grossTotal = '100.00';
    invoice.buyer = { ...invoice.buyer, vatId: 'DE811907980' };

    expect(
      validateExtractedInvoice(invoice, VALIDATION_DATE).filter(
        (finding) => !finding.passed && finding.severity === Severity.ERROR,
      ),
    ).toEqual([]);
  });

  it.each([
    ['seller', 'seller.vatId', 'mandatory.vat_category_seller_vat_id'],
    ['buyer', 'buyer.vatId', 'mandatory.vat_category_buyer_identity'],
  ] as const)(
    'requires a %s VAT ID for the intra-community-supply category',
    (party, field, rule) => {
      const invoice = validInvoice();
      invoice.lineItems[0] = { ...firstLineItem(invoice), vatRate: '0' };
      invoice.vatBreakdown[0] = {
        ...firstVatBreakdown(invoice),
        rate: '0',
        amount: '0.00',
        category: 'K',
        exemptionReason: 'Intra-community supply',
      };
      invoice.vatTotal = '0.00';
      invoice.grossTotal = '100.00';
      invoice[party] = { ...invoice[party], vatId: null };

      expect(
        findingFor(
          validateExtractedInvoice(invoice, VALIDATION_DATE),
          rule,
          field,
        ),
      ).toEqual(
        expect.objectContaining({ passed: false, severity: Severity.ERROR }),
      );
    },
  );

  it('rejects an unsupported buyer VAT-ID prefix before generation', () => {
    const invoice = validInvoice();
    invoice.buyer = { ...invoice.buyer, vatId: 'XX123456' };

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.vat_id_prefix',
        'buyer.vatId',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('blocks an invalid German buyer VAT-ID checksum', () => {
    const invoice = validInvoice();
    invoice.buyer = { ...invoice.buyer, vatId: 'DE811907981' };

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.vat_id_checksum',
        'buyer.vatId',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('blocks a date that matches the ISO shape but does not exist on the calendar', () => {
    const invoice = validInvoice();
    invoice.issueDate = '2026-02-30';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.calendar_date',
        'issueDate',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('reports malformed currency, country, and German postal code fields at their documented severities', () => {
    const invoice = validInvoice();
    invoice.currency = 'ZZZ';
    invoice.buyer = {
      ...invoice.buyer,
      countryCode: 'ZZ',
    };
    invoice.seller = {
      ...invoice.seller,
      postalCode: '1234',
    };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'format.currency', 'currency')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
    expect(
      findingFor(findings, 'format.country_code', 'buyer.countryCode'),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
    expect(
      findingFor(findings, 'format.postal_code_de', 'seller.postalCode'),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
  });

  it('rejects a currency that the XRechnung mapper cannot generate', () => {
    const invoice = validInvoice();
    invoice.currency = 'HRK';

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.currency',
        'currency',
      ),
    ).toEqual(expect.objectContaining({ passed: false }));
  });

  it('warns about a country code that the XRechnung mapper cannot generate', () => {
    const invoice = validInvoice();
    invoice.buyer = { ...invoice.buyer, countryCode: 'UK' };

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'format.country_code',
        'buyer.countryCode',
      ),
    ).toEqual(expect.objectContaining({ passed: false }));
  });

  it.each([
    ['2016-08-10', true],
    ['2027-08-10', true],
    ['2016-08-09', false],
    ['2027-08-11', false],
  ])('applies the issue-date range boundary for %s', (issueDate, passed) => {
    const invoice = validInvoice();
    invoice.issueDate = issueDate;

    expect(
      findingFor(
        validateExtractedInvoice(invoice, VALIDATION_DATE),
        'plausible.date_range',
        'issueDate',
      ),
    ).toEqual(expect.objectContaining({ passed, severity: Severity.WARNING }));
  });

  it('keeps a warning-only date-range failure out of mandatory review', () => {
    const invoice = validInvoice();
    invoice.issueDate = '2016-08-09';

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.date_range', 'issueDate')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.WARNING }),
    );
    expect(
      findings.filter(
        (finding) => !finding.passed && finding.severity === Severity.ERROR,
      ),
    ).toEqual([]);
    expect(reviewRoutingStatus(findings)).toBe(InvoiceStatus.GENERATING);
  });

  it('blocks missing XRechnung buyer reference, payment terms, and seller contact details', () => {
    const invoice = validInvoice();
    invoice.buyerReference = null;
    invoice.dueDate = null;
    invoice.paymentTerms = null;
    invoice.seller = {
      ...invoice.seller,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
    };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'mandatory.buyer_reference')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
    expect(findingFor(findings, 'mandatory.payment_terms')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
    expect(findingFor(findings, 'mandatory.seller_contact')).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('requires XRechnung electronic addresses and schemes', () => {
    const invoice = validInvoice();
    invoice.seller = {
      ...invoice.seller,
      electronicAddress: null,
      electronicAddressScheme: null,
    };
    invoice.buyer = {
      ...invoice.buyer,
      electronicAddress: null,
      electronicAddressScheme: null,
    };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(
      findingFor(
        findings,
        'mandatory.electronic_address',
        'seller.electronicAddress',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
    expect(
      findingFor(
        findings,
        'mandatory.electronic_address',
        'buyer.electronicAddress',
      ),
    ).toEqual(
      expect.objectContaining({ passed: false, severity: Severity.ERROR }),
    );
  });

  it('blocks incomplete statutory fields and missing monetary data', () => {
    const invoice = validInvoice();
    invoice.invoiceNumber = null;
    invoice.issueDate = null;
    invoice.currency = null;
    invoice.seller = {
      ...invoice.seller,
      name: null,
      street: null,
      postalCode: null,
      city: null,
      countryCode: null,
      vatId: null,
      taxNumber: null,
    };
    invoice.buyer = {
      ...invoice.buyer,
      name: null,
      street: null,
      postalCode: null,
      city: null,
      countryCode: null,
    };
    invoice.lineItems[0] = {
      ...firstLineItem(invoice),
      description: null,
      quantity: null,
      netAmount: null,
      vatRate: null,
    };
    invoice.vatBreakdown[0] = {
      ...firstVatBreakdown(invoice),
      rate: null,
      amount: null,
      exemptionReason: null,
    };
    invoice.netTotal = null;
    invoice.vatTotal = null;
    invoice.grossTotal = null;

    const failedRules = validateExtractedInvoice(invoice, VALIDATION_DATE)
      .filter(
        (finding) => !finding.passed && finding.severity === Severity.ERROR,
      )
      .map((finding) => finding.rule);

    expect(failedRules).toEqual(
      expect.arrayContaining([
        'mandatory.seller_identity',
        'mandatory.buyer_identity',
        'mandatory.seller_tax_id',
        'mandatory.issue_date',
        'mandatory.invoice_number',
        'mandatory.currency',
        'mandatory.line_descriptions',
        'mandatory.line_amounts',
        'mandatory.line_vat_rate_or_exemption',
        'mandatory.vat_rate_or_exemption',
        'mandatory.monetary_total',
      ]),
    );
  });

  it('rejects a German VAT ID that does not have exactly nine digits', () => {
    const invoice = { ...validInvoice() };
    invoice.seller = { ...invoice.seller, vatId: 'DE12345' };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'format.vat_id_syntax')).toMatchObject({
      severity: Severity.ERROR,
      passed: false,
    });
  });

  it('warns about a missing delivery date without blocking', () => {
    const invoice = { ...validInvoice(), deliveryDate: null };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'mandatory.delivery_date')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('warns about a missing seller IBAN without blocking', () => {
    const invoice = { ...validInvoice(), sellerIban: null };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'mandatory.seller_iban')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('blocks an invoice with no VAT breakdown', () => {
    const invoice = { ...validInvoice(), vatBreakdown: [] };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'mandatory.vat_breakdown')).toMatchObject({
      severity: Severity.ERROR,
      passed: false,
    });
  });

  it('warns when the delivery date is after the invoice issue date', () => {
    const invoice = { ...validInvoice(), deliveryDate: '2026-08-11' };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.date_order')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('warns about a negative total instead of blocking', () => {
    const invoice = { ...validInvoice(), grossTotal: '-119.00' };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.positive_amounts')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('blocks an invoice with no line items', () => {
    const invoice = { ...validInvoice(), lineItems: [] };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.line_count')).toMatchObject({
      severity: Severity.ERROR,
      passed: false,
    });
  });

  it('warns about a gross total at or above the supported magnitude limit', () => {
    const invoice = { ...validInvoice(), grossTotal: '10000000.00' };

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.magnitude')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('warns about a VAT rate outside the supported standard rates', () => {
    const invoice = { ...validInvoice() };
    invoice.vatBreakdown = [{ ...firstVatBreakdown(invoice), rate: '5' }];

    const findings = validateExtractedInvoice(invoice, VALIDATION_DATE);

    expect(findingFor(findings, 'plausible.vat_rate')).toMatchObject({
      severity: Severity.WARNING,
      passed: false,
    });
  });

  it('returns a schema.extracted_data error instead of throwing on a non-canonical decimal', () => {
    const invoice: unknown = { ...validInvoice(), netTotal: '1,50' };

    expect(validateExtractedInvoice(invoice, VALIDATION_DATE)).toEqual([
      {
        rule: 'schema.extracted_data',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message:
          'Stored extracted data no longer matches the validation schema.',
      },
    ]);
  });

  it('returns the missing-data schema.extracted_data error for a null input', () => {
    expect(validateExtractedInvoice(null, VALIDATION_DATE)).toEqual([
      {
        rule: 'schema.extracted_data',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message: 'No schema-valid extracted data is available for validation.',
      },
    ]);
  });
});

describe('reviewRoutingStatus', () => {
  function finding(overrides: Partial<ValidationFinding>): ValidationFinding {
    return {
      rule: 'arithmetic.gross',
      field: null,
      severity: Severity.ERROR,
      passed: true,
      message: 'test finding',
      ...overrides,
    };
  }

  it.each([
    [
      'a failed ERROR finding',
      [finding({ severity: Severity.ERROR, passed: false })],
      InvoiceStatus.NEEDS_REVIEW,
    ],
    [
      'a failed WARNING finding',
      [finding({ severity: Severity.WARNING, passed: false })],
      InvoiceStatus.GENERATING,
    ],
    [
      'a failed INFO finding',
      [finding({ severity: Severity.INFO, passed: false })],
      InvoiceStatus.GENERATING,
    ],
    [
      'a passed ERROR finding',
      [finding({ severity: Severity.ERROR, passed: true })],
      InvoiceStatus.GENERATING,
    ],
    ['no findings', [], InvoiceStatus.GENERATING],
  ] as const)(
    'routes %s to the correct invoice status',
    (_description, findings, expected) => {
      expect(reviewRoutingStatus([...findings])).toBe(expected);
    },
  );
});
