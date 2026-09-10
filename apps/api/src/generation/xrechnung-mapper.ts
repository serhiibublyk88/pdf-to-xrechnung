import type { Invoice } from '@e-invoice-eu/core';
import { Severity } from '@prisma/client';
import {
  IMPLIED_VAT_EXEMPTION_REASON_CODES,
  resolveUnitCode as resolveSharedUnitCode,
  type LineItem,
  type MappingRuleCode,
  type Party,
  type RawExtractedInvoiceData,
  type VatBreakdown,
  type VatCategoryCode,
} from '@pdf-to-xrechnung/contracts';
import {
  canonicalDecimalKey,
  parseDecimalString,
  toMinorUnitsFromDecimal,
} from '../money/decimal';
import {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCY_CODES,
  SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES,
  type InvoiceCurrencyCode,
  type InvoicedQuantityUnitOfMeasure,
  type SellerCountryCode,
  type SellerElectronicAddressIdentificationSchemeIdentifier,
  type UblVatExemptionReasonCode,
} from './e-invoice-eu-code-lists';

type UblInvoice = Invoice['ubl:Invoice'];
type SellerParty = UblInvoice['cac:AccountingSupplierParty']['cac:Party'];
type BuyerParty = UblInvoice['cac:AccountingCustomerParty']['cac:Party'];
type PostalAddress = SellerParty['cac:PostalAddress'];
type LegalEntity = { 'cbc:RegistrationName': string };
type Contact = {
  'cbc:Name'?: string;
  'cbc:Telephone'?: string;
  'cbc:ElectronicMail'?: string;
};
type TaxSchemeEntry = {
  'cbc:CompanyID': string;
  'cac:TaxScheme': { 'cbc:ID': string };
};
type InvoiceLine = UblInvoice['cac:InvoiceLine'][number];
type TaxTotal = UblInvoice['cac:TaxTotal'][number];
type VatSubtotal = NonNullable<TaxTotal['cac:TaxSubtotal']>[number];

export type MappingFinding = {
  rule: MappingRuleCode;
  field: string | null;
  severity: typeof Severity.ERROR;
  passed: false;
  message: string;
};

export type XrechnungMappingResult =
  { ok: true; invoice: Invoice } | { ok: false; findings: MappingFinding[] };

export function mappingFinding(
  rule: MappingRuleCode,
  field: string | null,
  message: string,
): MappingFinding {
  return { rule, field, severity: Severity.ERROR, passed: false, message };
}

function requireText(
  value: string | null,
  rule: MappingRuleCode,
  field: string,
  message: string,
  findings: MappingFinding[],
): string | undefined {
  const text = value?.trim() ?? '';
  if (text.length === 0) {
    findings.push(mappingFinding(rule, field, message));
    return undefined;
  }
  return text;
}

function formatAmount(decimalString: string): string {
  const minorUnits = toMinorUnitsFromDecimal(parseDecimalString(decimalString));
  const sign = minorUnits < 0n ? '-' : '';
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function requireAmount(
  value: string | null,
  rule: MappingRuleCode,
  field: string,
  message: string,
  findings: MappingFinding[],
): string | undefined {
  const raw = requireText(value, rule, field, message, findings);
  if (raw === undefined) {
    return undefined;
  }
  if (parseDecimalString(raw).scale > 2) {
    findings.push(
      mappingFinding(
        'mapping.amount_precision',
        field,
        `Amount "${raw}" has more than two decimal places.`,
      ),
    );
    return undefined;
  }
  return formatAmount(raw);
}

function isSupportedCurrency(code: string): code is InvoiceCurrencyCode {
  return SUPPORTED_CURRENCY_CODES.has(code);
}

function isSupportedCountryCode(code: string): code is SellerCountryCode {
  return SUPPORTED_COUNTRY_CODES.has(code);
}

function isSupportedElectronicAddressScheme(
  scheme: string,
): scheme is SellerElectronicAddressIdentificationSchemeIdentifier {
  return SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES.has(scheme);
}

function resolveUnitCode(
  unit: string | null,
  field: string,
  findings: MappingFinding[],
): InvoicedQuantityUnitOfMeasure | undefined {
  if (unit === null) {
    findings.push(
      mappingFinding(
        'mapping.line_unit',
        field,
        'Line item unit is required; no unit was printed on the invoice.',
      ),
    );
    return undefined;
  }
  const code = resolveSharedUnitCode(unit);
  if (code === undefined) {
    findings.push(
      mappingFinding(
        'mapping.line_unit',
        field,
        `Printed unit "${unit}" has no known XRechnung unit code.`,
      ),
    );
    return undefined;
  }
  return code;
}

function resolveVatCategory(
  rate: string | null,
  category: VatCategoryCode | null,
  rule: MappingRuleCode,
  field: string,
  findings: MappingFinding[],
): { category: VatCategoryCode; percent: string } | undefined {
  const rateText = requireText(
    rate,
    rule,
    field,
    'VAT rate is required to derive an XRechnung VAT category.',
    findings,
  );
  if (rateText === undefined) {
    return undefined;
  }
  const coefficient = parseDecimalString(rateText).coefficient;

  if (category === null || category === 'S') {
    if (coefficient > 0n) {
      return { category: 'S', percent: rateText };
    }
    findings.push(
      mappingFinding(
        rule,
        field,
        coefficient < 0n
          ? `VAT rate "${rateText}" cannot be negative.`
          : 'A zero or exempt VAT rate needs a VAT category (reverse charge, intra-community supply, export, exempt, or zero-rated).',
      ),
    );
    return undefined;
  }

  if (coefficient !== 0n) {
    findings.push(
      mappingFinding(
        rule,
        field,
        `VAT category "${category}" requires a zero VAT rate; found "${rateText}".`,
      ),
    );
    return undefined;
  }

  return { category, percent: rateText };
}

function buildRateCategoryIndex(
  vatBreakdown: VatBreakdown[],
): Map<string, Set<VatCategoryCode | null>> {
  const index = new Map<string, Set<VatCategoryCode | null>>();
  for (const entry of vatBreakdown) {
    if (entry.rate === null) {
      continue;
    }
    const key = canonicalDecimalKey(entry.rate);
    const categories = index.get(key) ?? new Set<VatCategoryCode | null>();
    categories.add(entry.category);
    index.set(key, categories);
  }
  return index;
}

function resolveLineItemVatCategory(
  rate: string | null,
  rateCategoryIndex: Map<string, Set<VatCategoryCode | null>>,
  field: string,
  findings: MappingFinding[],
): { category: VatCategoryCode; percent: string } | undefined {
  const categoriesForRate =
    rate === null
      ? undefined
      : rateCategoryIndex.get(canonicalDecimalKey(rate));
  if (categoriesForRate !== undefined && categoriesForRate.size > 1) {
    findings.push(
      mappingFinding(
        'mapping.line_vat_category',
        field,
        `VAT rate "${rate}" is used by VAT breakdown groups with different categories; this line's category is ambiguous.`,
      ),
    );
    return undefined;
  }
  const [category] = categoriesForRate ?? [];
  return resolveVatCategory(
    rate,
    category ?? null,
    'mapping.line_vat_category',
    field,
    findings,
  );
}

function resolveVatExemption(
  category: VatCategoryCode,
  exemptionReasonText: string | null,
  field: string,
  findings: MappingFinding[],
): { code?: UblVatExemptionReasonCode; text?: string } | undefined {
  switch (category) {
    case 'AE':
    case 'K':
    case 'G':
      return { code: IMPLIED_VAT_EXEMPTION_REASON_CODES[category] };
    case 'E': {
      const text = requireText(
        exemptionReasonText,
        'mapping.vat_breakdown_category',
        field,
        'An exemption reason is required for VAT category E (§ 4 UStG exemption).',
        findings,
      );
      return text === undefined ? undefined : { text };
    }
    case 'Z':
    case 'S':
      return {};
  }
}

function resolvePostalAddress(
  party: Party,
  partyLabel: string,
  findings: MappingFinding[],
): PostalAddress | undefined {
  const postalCode = requireText(
    party.postalCode,
    'mapping.party_address',
    `${partyLabel}.postalCode`,
    `${partyLabel} post code is required.`,
    findings,
  );
  const city = requireText(
    party.city,
    'mapping.party_address',
    `${partyLabel}.city`,
    `${partyLabel} city is required.`,
    findings,
  );
  const countryCode = requireText(
    party.countryCode,
    'mapping.party_address',
    `${partyLabel}.countryCode`,
    `${partyLabel} country code is required.`,
    findings,
  );
  if (
    postalCode === undefined ||
    city === undefined ||
    countryCode === undefined
  ) {
    return undefined;
  }
  if (!isSupportedCountryCode(countryCode)) {
    findings.push(
      mappingFinding(
        'mapping.party_country_code',
        `${partyLabel}.countryCode`,
        `Country code "${countryCode}" is not supported by the XRechnung UBL profile.`,
      ),
    );
    return undefined;
  }

  return {
    ...(party.street !== null ? { 'cbc:StreetName': party.street } : {}),
    'cbc:CityName': city,
    'cbc:PostalZone': postalCode,
    'cac:Country': { 'cbc:IdentificationCode': countryCode },
  };
}

function resolveElectronicAddress(
  party: Party,
  partyLabel: string,
  findings: MappingFinding[],
):
  | {
      id: string;
      scheme: SellerElectronicAddressIdentificationSchemeIdentifier;
    }
  | undefined {
  const address = requireText(
    party.electronicAddress,
    'mapping.electronic_address',
    `${partyLabel}.electronicAddress`,
    `${partyLabel} electronic address is required.`,
    findings,
  );
  const scheme = requireText(
    party.electronicAddressScheme,
    'mapping.electronic_address',
    `${partyLabel}.electronicAddressScheme`,
    `${partyLabel} electronic address scheme is required.`,
    findings,
  );
  if (address === undefined || scheme === undefined) {
    return undefined;
  }
  if (!isSupportedElectronicAddressScheme(scheme)) {
    findings.push(
      mappingFinding(
        'mapping.electronic_address_scheme',
        `${partyLabel}.electronicAddressScheme`,
        `Electronic address scheme "${scheme}" is not currently supported by this project's XRechnung generator/validator target.`,
      ),
    );
    return undefined;
  }
  return { id: address, scheme };
}

function resolveContact(party: Party): Contact | undefined {
  if (
    party.contactName === null &&
    party.contactPhone === null &&
    party.contactEmail === null
  ) {
    return undefined;
  }
  return {
    ...(party.contactName !== null ? { 'cbc:Name': party.contactName } : {}),
    ...(party.contactPhone !== null
      ? { 'cbc:Telephone': party.contactPhone }
      : {}),
    ...(party.contactEmail !== null
      ? { 'cbc:ElectronicMail': party.contactEmail }
      : {}),
  };
}

function resolveSellerParty(
  seller: Party,
  findings: MappingFinding[],
): SellerParty | undefined {
  const name = requireText(
    seller.name,
    'mapping.party_address',
    'seller.name',
    'Seller name is required.',
    findings,
  );
  const postalAddress = resolvePostalAddress(seller, 'seller', findings);
  const electronicAddress = resolveElectronicAddress(
    seller,
    'seller',
    findings,
  );
  const contact = resolveContact(seller);
  const taxId = requireText(
    seller.vatId,
    'mapping.seller_tax_id',
    'seller.vatId',
    'Seller VAT ID is required to map an XRechnung tax scheme; a Steuernummer alone is not currently mapped.',
    findings,
  );

  if (
    name === undefined ||
    postalAddress === undefined ||
    electronicAddress === undefined ||
    taxId === undefined
  ) {
    return undefined;
  }

  const taxScheme: TaxSchemeEntry = {
    'cbc:CompanyID': taxId,
    'cac:TaxScheme': { 'cbc:ID': 'VAT' },
  };
  const legalEntity: LegalEntity = { 'cbc:RegistrationName': name };

  return {
    'cbc:EndpointID': electronicAddress.id,
    'cbc:EndpointID@schemeID': electronicAddress.scheme,
    'cac:PostalAddress': postalAddress,
    'cac:PartyTaxScheme': [taxScheme],
    'cac:PartyLegalEntity': legalEntity,
    ...(contact !== undefined ? { 'cac:Contact': contact } : {}),
  };
}

function resolveBuyerParty(
  buyer: Party,
  findings: MappingFinding[],
): BuyerParty | undefined {
  const name = requireText(
    buyer.name,
    'mapping.party_address',
    'buyer.name',
    'Buyer name is required.',
    findings,
  );
  const postalAddress = resolvePostalAddress(buyer, 'buyer', findings);
  const electronicAddress = resolveElectronicAddress(buyer, 'buyer', findings);
  const contact = resolveContact(buyer);

  if (
    name === undefined ||
    postalAddress === undefined ||
    electronicAddress === undefined
  ) {
    return undefined;
  }

  const legalEntity: LegalEntity = { 'cbc:RegistrationName': name };

  return {
    'cbc:EndpointID': electronicAddress.id,
    'cbc:EndpointID@schemeID': electronicAddress.scheme,
    'cac:PostalAddress': postalAddress,
    ...(buyer.vatId !== null
      ? {
          'cac:PartyTaxScheme': {
            'cbc:CompanyID': buyer.vatId,
            'cac:TaxScheme': { 'cbc:ID': 'VAT' },
          } satisfies TaxSchemeEntry,
        }
      : {}),
    'cac:PartyLegalEntity': legalEntity,
    ...(contact !== undefined ? { 'cac:Contact': contact } : {}),
  };
}

function resolveLineItem(
  item: LineItem,
  index: number,
  currency: InvoiceCurrencyCode | undefined,
  rateCategoryIndex: Map<string, Set<VatCategoryCode | null>>,
  findings: MappingFinding[],
): InvoiceLine | undefined {
  const field = `lineItems[${index}]`;
  const description = requireText(
    item.description,
    'mapping.line_item',
    `${field}.description`,
    `Line ${index + 1} description is required.`,
    findings,
  );
  const quantity = requireText(
    item.quantity,
    'mapping.line_item',
    `${field}.quantity`,
    `Line ${index + 1} quantity is required.`,
    findings,
  );
  const netAmount = requireAmount(
    item.netAmount,
    'mapping.line_item',
    `${field}.netAmount`,
    `Line ${index + 1} net amount is required.`,
    findings,
  );
  const unitCode = resolveUnitCode(item.unit, `${field}.unit`, findings);
  const vatCategory = resolveLineItemVatCategory(
    item.vatRate,
    rateCategoryIndex,
    `${field}.vatRate`,
    findings,
  );
  const unitPrice = requireText(
    item.unitPrice,
    'mapping.line_item',
    `${field}.unitPrice`,
    `Line ${index + 1} unit price is required.`,
    findings,
  );

  if (
    description === undefined ||
    quantity === undefined ||
    netAmount === undefined ||
    unitCode === undefined ||
    vatCategory === undefined ||
    unitPrice === undefined ||
    currency === undefined
  ) {
    return undefined;
  }

  return {
    'cbc:ID': String(item.position ?? index + 1),
    'cbc:InvoicedQuantity': quantity,
    'cbc:InvoicedQuantity@unitCode': unitCode,
    'cbc:LineExtensionAmount': netAmount,
    'cbc:LineExtensionAmount@currencyID': currency,
    'cac:Item': {
      'cbc:Name': description,
      'cac:ClassifiedTaxCategory': {
        'cbc:ID': vatCategory.category,
        'cbc:Percent': vatCategory.percent,
        'cac:TaxScheme': { 'cbc:ID': 'VAT' },
      },
    },
    'cac:Price': {
      'cbc:PriceAmount': unitPrice,
      'cbc:PriceAmount@currencyID': currency,
    },
  };
}

function resolveVatSubtotal(
  entry: VatBreakdown,
  index: number,
  currency: InvoiceCurrencyCode | undefined,
  findings: MappingFinding[],
): VatSubtotal | undefined {
  const field = `vatBreakdown[${index}]`;
  const base = requireAmount(
    entry.base,
    'mapping.vat_breakdown',
    `${field}.base`,
    `VAT breakdown ${index + 1} base is required.`,
    findings,
  );
  const amount = requireAmount(
    entry.amount,
    'mapping.vat_breakdown',
    `${field}.amount`,
    `VAT breakdown ${index + 1} amount is required.`,
    findings,
  );
  const vatCategory = resolveVatCategory(
    entry.rate,
    entry.category,
    'mapping.vat_breakdown_category',
    `${field}.rate`,
    findings,
  );

  if (
    base === undefined ||
    amount === undefined ||
    vatCategory === undefined ||
    currency === undefined
  ) {
    return undefined;
  }

  const exemption = resolveVatExemption(
    vatCategory.category,
    entry.exemptionReason,
    `${field}.exemptionReason`,
    findings,
  );
  if (exemption === undefined) {
    return undefined;
  }

  return {
    'cbc:TaxableAmount': base,
    'cbc:TaxableAmount@currencyID': currency,
    'cbc:TaxAmount': amount,
    'cbc:TaxAmount@currencyID': currency,
    'cac:TaxCategory': {
      'cbc:ID': vatCategory.category,
      'cbc:Percent': vatCategory.percent,
      ...(exemption.code !== undefined
        ? { 'cbc:TaxExemptionReasonCode': exemption.code }
        : {}),
      ...(exemption.text !== undefined
        ? { 'cbc:TaxExemptionReason': exemption.text }
        : {}),
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    },
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// BR-IC-12: K's only verified delivery address is the buyer's address.
function resolveDelivery(
  deliveryDate: string | null,
  hasIntraCommunitySupply: boolean,
  buyer: BuyerParty,
): UblInvoice['cac:Delivery'] | undefined {
  const buyerAddress = hasIntraCommunitySupply
    ? buyer['cac:PostalAddress']
    : undefined;

  if (deliveryDate === null && buyerAddress === undefined) {
    return undefined;
  }
  return {
    ...(deliveryDate !== null
      ? { 'cbc:ActualDeliveryDate': deliveryDate }
      : {}),
    ...(buyerAddress !== undefined
      ? {
          'cac:DeliveryLocation': {
            'cac:Address': {
              // BR-DE-10/-11 require city and postal code whenever delivery is emitted.
              'cbc:CityName': buyerAddress['cbc:CityName'],
              'cbc:PostalZone': buyerAddress['cbc:PostalZone'],
              'cac:Country': buyerAddress['cac:Country'],
            },
          },
        }
      : {}),
  };
}

export function mapToXRechnungInvoice(
  data: RawExtractedInvoiceData,
): XrechnungMappingResult {
  const findings: MappingFinding[] = [];

  const invoiceNumber = requireText(
    data.invoiceNumber,
    'mapping.invoice_header',
    'invoiceNumber',
    'Invoice number is required.',
    findings,
  );
  const issueDate = requireText(
    data.issueDate,
    'mapping.invoice_header',
    'issueDate',
    'Issue date is required.',
    findings,
  );
  const buyerReference = requireText(
    data.buyerReference,
    'mapping.invoice_header',
    'buyerReference',
    'Buyer reference is required.',
    findings,
  );
  const currencyText = requireText(
    data.currency,
    'mapping.invoice_header',
    'currency',
    'Currency is required.',
    findings,
  );
  let currency: InvoiceCurrencyCode | undefined;
  if (currencyText !== undefined) {
    if (isSupportedCurrency(currencyText)) {
      currency = currencyText;
    } else {
      findings.push(
        mappingFinding(
          'mapping.currency',
          'currency',
          `Currency "${currencyText}" is not supported by the XRechnung UBL profile.`,
        ),
      );
    }
  }
  const netTotal = requireAmount(
    data.netTotal,
    'mapping.invoice_header',
    'netTotal',
    'Net total is required.',
    findings,
  );
  const vatTotal = requireAmount(
    data.vatTotal,
    'mapping.invoice_header',
    'vatTotal',
    'VAT total is required.',
    findings,
  );
  const grossTotal = requireAmount(
    data.grossTotal,
    'mapping.invoice_header',
    'grossTotal',
    'Gross total is required.',
    findings,
  );

  const seller = resolveSellerParty(data.seller, findings);
  const buyer = resolveBuyerParty(data.buyer, findings);
  if (data.lineItems.length === 0) {
    findings.push(
      mappingFinding(
        'mapping.line_item',
        'lineItems',
        'At least one line item is required.',
      ),
    );
  }
  if (data.vatBreakdown.length === 0) {
    findings.push(
      mappingFinding(
        'mapping.vat_breakdown',
        'vatBreakdown',
        'At least one VAT breakdown entry is required.',
      ),
    );
  }
  const rateCategoryIndex = buildRateCategoryIndex(data.vatBreakdown);
  const lineItems = data.lineItems
    .map((item, index) =>
      resolveLineItem(item, index, currency, rateCategoryIndex, findings),
    )
    .filter(isDefined);
  const vatBreakdown = data.vatBreakdown
    .map((entry, index) => resolveVatSubtotal(entry, index, currency, findings))
    .filter(isDefined);

  if (
    findings.length > 0 ||
    invoiceNumber === undefined ||
    issueDate === undefined ||
    buyerReference === undefined ||
    currency === undefined ||
    netTotal === undefined ||
    vatTotal === undefined ||
    grossTotal === undefined ||
    seller === undefined ||
    buyer === undefined ||
    lineItems.length === 0 ||
    vatBreakdown.length === 0
  ) {
    return { ok: false, findings };
  }

  const [firstLine, ...restLines] = lineItems;
  if (!firstLine) {
    return { ok: false, findings };
  }
  const invoiceLine: [InvoiceLine, ...InvoiceLine[]] = [
    firstLine,
    ...restLines,
  ];
  const taxTotal: [TaxTotal] = [
    {
      'cbc:TaxAmount': vatTotal,
      'cbc:TaxAmount@currencyID': currency,
      'cac:TaxSubtotal': vatBreakdown,
    },
  ];
  const hasIntraCommunitySupply = data.vatBreakdown.some(
    (entry) => entry.category === 'K',
  );
  const delivery = resolveDelivery(
    data.deliveryDate,
    hasIntraCommunitySupply,
    buyer,
  );

  return {
    ok: true,
    invoice: {
      'ubl:Invoice': {
        'cbc:ID': invoiceNumber,
        'cbc:IssueDate': issueDate,
        ...(data.dueDate !== null ? { 'cbc:DueDate': data.dueDate } : {}),
        'cbc:InvoiceTypeCode': '380',
        'cbc:DocumentCurrencyCode': currency,
        'cbc:BuyerReference': buyerReference,
        'cac:AccountingSupplierParty': { 'cac:Party': seller },
        'cac:AccountingCustomerParty': { 'cac:Party': buyer },
        ...(delivery !== undefined ? { 'cac:Delivery': delivery } : {}),
        ...(data.sellerIban !== null
          ? {
              'cac:PaymentMeans': [
                {
                  'cbc:PaymentMeansCode': '58',
                  'cac:PayeeFinancialAccount': {
                    'cbc:ID': data.sellerIban,
                    ...(data.sellerBic !== null
                      ? {
                          'cac:FinancialInstitutionBranch': {
                            'cbc:ID': data.sellerBic,
                          },
                        }
                      : {}),
                  },
                },
              ],
            }
          : {}),
        ...(data.paymentTerms !== null
          ? { 'cac:PaymentTerms': { 'cbc:Note': data.paymentTerms } }
          : {}),
        'cac:TaxTotal': taxTotal,
        'cac:LegalMonetaryTotal': {
          'cbc:LineExtensionAmount': netTotal,
          'cbc:LineExtensionAmount@currencyID': currency,
          'cbc:TaxExclusiveAmount': netTotal,
          'cbc:TaxExclusiveAmount@currencyID': currency,
          'cbc:TaxInclusiveAmount': grossTotal,
          'cbc:TaxInclusiveAmount@currencyID': currency,
          'cbc:PayableAmount': grossTotal,
          'cbc:PayableAmount@currencyID': currency,
        },
        'cac:InvoiceLine': invoiceLine,
      },
    },
  };
}
