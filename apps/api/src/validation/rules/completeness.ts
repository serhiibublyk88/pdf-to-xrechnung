import { Severity } from '@prisma/client';
import {
  VAT_CATEGORIES_REQUIRING_FREE_TEXT_REASON,
  type Party,
} from '@pdf-to-xrechnung/contracts';
import {
  isPresent,
  presenceFinding,
  runPresenceRules,
  type ParsedInvoice,
  type PresenceRule,
  type ValidationFinding,
} from './shared';

const SELLER_IDENTITY_RULE = 'mandatory.seller_identity';
const BUYER_IDENTITY_RULE = 'mandatory.buyer_identity';
const PARTY_STREET_RULE = 'mandatory.party_street';
const ELECTRONIC_ADDRESS_RULE = 'mandatory.electronic_address';
const SELLER_CONTACT_RULE = 'mandatory.seller_contact';
const LINE_VAT_RATE_OR_EXEMPTION_RULE = 'mandatory.line_vat_rate_or_exemption';
const VAT_RATE_OR_EXEMPTION_RULE = 'mandatory.vat_rate_or_exemption';
const MONETARY_TOTAL_RULE = 'mandatory.monetary_total';
const VAT_CATEGORY_RULE = 'mandatory.vat_category';
const VAT_CATEGORY_REASON_RULE = 'mandatory.vat_category_reason';
const VAT_CATEGORY_BUYER_IDENTITY_RULE =
  'mandatory.vat_category_buyer_identity';
const VAT_CATEGORY_SELLER_VAT_ID_RULE = 'mandatory.vat_category_seller_vat_id';

// XRechnung 3.0.2 accepts a party address without a street.
const invoiceParties = [
  { name: 'seller', label: 'Seller' },
  { name: 'buyer', label: 'Buyer' },
] as const;

const identityFields: ReadonlyArray<{ key: keyof Party; label: string }> = [
  { key: 'name', label: 'name' },
  { key: 'postalCode', label: 'post code' },
  { key: 'city', label: 'city' },
  { key: 'countryCode', label: 'country' },
];

const sellerContactFields: ReadonlyArray<{
  key: 'contactName' | 'contactEmail' | 'contactPhone';
  label: string;
}> = [
  { key: 'contactName', label: 'name' },
  { key: 'contactEmail', label: 'email' },
  { key: 'contactPhone', label: 'phone' },
];

const COMPLETENESS_RULES: readonly PresenceRule[] = [
  {
    rule: 'mandatory.seller_tax_id',
    field: 'seller.vatId',
    severity: Severity.ERROR,
    evaluate: (parsed) =>
      isPresent(parsed.source.seller.vatId) ||
      isPresent(parsed.source.seller.taxNumber),
    whenPassed: 'Seller VAT ID or tax number is present.',
    whenFailed: 'Seller VAT ID or tax number is required.',
  },
  {
    rule: 'mandatory.issue_date',
    field: 'issueDate',
    severity: Severity.ERROR,
    evaluate: (parsed) => parsed.source.issueDate !== null,
    whenPassed: 'Invoice issue date is present.',
    whenFailed: 'Invoice issue date is required.',
  },
  {
    rule: 'mandatory.invoice_number',
    field: 'invoiceNumber',
    severity: Severity.ERROR,
    evaluate: (parsed) => isPresent(parsed.source.invoiceNumber),
    whenPassed: 'Invoice number is present.',
    whenFailed: 'Invoice number is required.',
  },
  {
    rule: 'mandatory.currency',
    field: 'currency',
    severity: Severity.ERROR,
    evaluate: (parsed) => parsed.source.currency !== null,
    whenPassed: 'Currency is present.',
    whenFailed: 'Currency is required.',
  },
  {
    rule: 'mandatory.buyer_reference',
    field: 'buyerReference',
    severity: Severity.ERROR,
    evaluate: (parsed) => isPresent(parsed.source.buyerReference),
    whenPassed: 'Buyer reference is present.',
    whenFailed: 'Buyer reference is required for XRechnung.',
  },
  {
    rule: 'mandatory.payment_terms',
    field: 'paymentTerms',
    severity: Severity.ERROR,
    evaluate: (parsed) => {
      if (
        parsed.grossTotal.minorUnits === null ||
        parsed.grossTotal.minorUnits <= 0n
      ) {
        return undefined;
      }
      return (
        parsed.source.dueDate !== null || isPresent(parsed.source.paymentTerms)
      );
    },
    whenPassed: 'Payment due date or payment terms are present.',
    whenFailed:
      'Payment due date or payment terms are required for an amount due.',
  },
  {
    rule: 'mandatory.seller_iban',
    field: 'sellerIban',
    severity: Severity.WARNING,
    evaluate: (parsed) => isPresent(parsed.source.sellerIban),
    whenPassed: 'Seller IBAN is present.',
    whenFailed: 'Seller IBAN is missing.',
  },
  {
    rule: 'mandatory.line_descriptions',
    field: 'lineItems',
    severity: Severity.ERROR,
    evaluate: (parsed) =>
      parsed.source.lineItems.length > 0 &&
      parsed.source.lineItems.every(
        (lineItem) =>
          isPresent(lineItem.description) && lineItem.quantity !== null,
      ),
    whenPassed: 'Every line item has a description and quantity.',
    whenFailed: 'Every line item needs a description and quantity.',
  },
  {
    rule: 'mandatory.line_amounts',
    field: 'lineItems',
    severity: Severity.ERROR,
    evaluate: (parsed) =>
      parsed.source.lineItems.length > 0 &&
      parsed.source.lineItems.every((lineItem) => lineItem.netAmount !== null),
    whenPassed: 'Every line item has a net amount.',
    whenFailed: 'Every line item needs a net amount for XRechnung.',
  },
  {
    rule: 'mandatory.delivery_date',
    field: 'deliveryDate',
    severity: Severity.WARNING,
    evaluate: (parsed) => parsed.source.deliveryDate !== null,
    whenPassed: 'Delivery or service date is present.',
    whenFailed: 'Delivery or service date is missing.',
  },
  {
    rule: 'mandatory.vat_breakdown',
    field: 'vatBreakdown',
    severity: Severity.ERROR,
    evaluate: (parsed) => parsed.source.vatBreakdown.length > 0,
    whenPassed: 'VAT breakdown is present.',
    whenFailed: 'At least one VAT breakdown is required.',
  },
];

export function validateCompleteness(
  parsed: ParsedInvoice,
): ValidationFinding[] {
  const results: ValidationFinding[] = [];
  const { source } = parsed;

  // KoSIT ablation: name, post code and city each fail on their own (BR-07/-10, BR-DE-3/-9).
  for (const { name: partyName, label: partyLabel } of invoiceParties) {
    const party = source[partyName];
    const identityRule =
      partyName === 'seller' ? SELLER_IDENTITY_RULE : BUYER_IDENTITY_RULE;

    for (const { key, label } of identityFields) {
      results.push(
        presenceFinding({
          rule: identityRule,
          field: `${partyName}.${key}`,
          severity: Severity.ERROR,
          passed: isPresent(party[key]),
          whenPassed: `${partyLabel} ${label} is present.`,
          whenFailed: `${partyLabel} ${label} is required.`,
        }),
      );
    }

    results.push(
      presenceFinding({
        rule: PARTY_STREET_RULE,
        field: `${partyName}.street`,
        severity: Severity.WARNING,
        passed: isPresent(party.street),
        whenPassed: `${partyLabel} street address is present.`,
        whenFailed: `${partyLabel} street address is missing.`,
      }),
    );
  }

  for (const { name: partyName, label: partyLabel } of invoiceParties) {
    const party = source[partyName];
    for (const key of [
      'electronicAddress',
      'electronicAddressScheme',
    ] as const) {
      results.push(
        presenceFinding({
          rule: ELECTRONIC_ADDRESS_RULE,
          field: `${partyName}.${key}`,
          severity: Severity.ERROR,
          passed: isPresent(party[key]),
          whenPassed: `${partyLabel} electronic address is present.`,
          whenFailed: `${partyLabel} electronic address and scheme are required for XRechnung.`,
        }),
      );
    }
  }

  for (const { key, label } of sellerContactFields) {
    results.push(
      presenceFinding({
        rule: SELLER_CONTACT_RULE,
        field: `seller.${key}`,
        severity: Severity.ERROR,
        passed: isPresent(source.seller[key]),
        whenPassed: `Seller contact ${label} is present.`,
        whenFailed: `Seller contact ${label} is required for XRechnung.`,
      }),
    );
  }

  for (const [index, lineItem] of parsed.lineItems.entries()) {
    const passed =
      lineItem.vatRate !== null ||
      isPresent(lineItem.source.vatExemptionReason);
    results.push(
      presenceFinding({
        rule: LINE_VAT_RATE_OR_EXEMPTION_RULE,
        field: `lineItems[${index}]`,
        severity: Severity.ERROR,
        passed,
        whenPassed: `Line item ${index + 1} has a VAT rate or exemption reason.`,
        whenFailed: `Line item ${index + 1} needs a VAT rate or exemption reason.`,
      }),
    );
  }

  let hasReverseCharge = false;
  let hasIntraCommunitySupply = false;
  for (const [index, vatBreakdown] of parsed.vatBreakdown.entries()) {
    const passed =
      (vatBreakdown.rate !== null && vatBreakdown.amount.decimal !== null) ||
      isPresent(vatBreakdown.source.exemptionReason);
    results.push(
      presenceFinding({
        rule: VAT_RATE_OR_EXEMPTION_RULE,
        field: `vatBreakdown[${index}]`,
        severity: Severity.ERROR,
        passed,
        whenPassed: `VAT breakdown ${index + 1} has a rate and amount or an exemption reason.`,
        whenFailed: `VAT breakdown ${index + 1} needs a rate and amount or an exemption reason.`,
      }),
    );

    const { category } = vatBreakdown.source;
    hasReverseCharge ||= category === 'AE';
    hasIntraCommunitySupply ||= category === 'K';
    if (vatBreakdown.rate !== null) {
      const coefficient = vatBreakdown.rate.coefficient;
      const categoryAllowsPositiveRate = category === null || category === 'S';
      const categoryMatchesRate = categoryAllowsPositiveRate
        ? coefficient > 0n
        : coefficient === 0n;
      results.push(
        presenceFinding({
          rule: VAT_CATEGORY_RULE,
          field: `vatBreakdown[${index}].category`,
          severity: Severity.ERROR,
          passed: categoryMatchesRate,
          whenPassed: 'VAT category is consistent with the VAT rate.',
          whenFailed:
            category === null
              ? 'A non-positive VAT rate needs a VAT category (reverse charge, intra-community supply, export, exempt, or zero-rated).'
              : category === 'S'
                ? 'VAT category "S" requires a positive VAT rate.'
                : `VAT category "${category}" requires a zero VAT rate.`,
        }),
      );
    }

    if (
      category !== null &&
      VAT_CATEGORIES_REQUIRING_FREE_TEXT_REASON.has(category)
    ) {
      results.push(
        presenceFinding({
          rule: VAT_CATEGORY_REASON_RULE,
          field: `vatBreakdown[${index}].exemptionReason`,
          severity: Severity.ERROR,
          passed: isPresent(vatBreakdown.source.exemptionReason),
          whenPassed:
            'Exemption reason is present for the § 4 UStG exemption category.',
          whenFailed:
            'An exemption reason is required for the § 4 UStG exemption category (E).',
        }),
      );
    }
  }

  if (hasIntraCommunitySupply) {
    results.push(
      presenceFinding({
        rule: VAT_CATEGORY_SELLER_VAT_ID_RULE,
        field: 'seller.vatId',
        severity: Severity.ERROR,
        passed: isPresent(source.seller.vatId),
        whenPassed:
          'Seller VAT ID is present for the intra-community-supply category.',
        whenFailed:
          'Seller VAT ID is required for the intra-community-supply VAT category (K).',
      }),
    );
  }

  if (hasReverseCharge || hasIntraCommunitySupply) {
    results.push(
      presenceFinding({
        rule: VAT_CATEGORY_BUYER_IDENTITY_RULE,
        field: 'buyer.vatId',
        severity: Severity.ERROR,
        passed: isPresent(source.buyer.vatId),
        whenPassed: 'Buyer VAT ID is present for the selected VAT category.',
        whenFailed:
          'Buyer VAT ID is required for the reverse-charge (AE) or intra-community-supply (K) VAT category.',
      }),
    );
  }

  for (const [field, amount] of [
    ['netTotal', parsed.netTotal],
    ['vatTotal', parsed.vatTotal],
    ['grossTotal', parsed.grossTotal],
  ] as const) {
    const passed = amount.decimal !== null;
    results.push(
      presenceFinding({
        rule: MONETARY_TOTAL_RULE,
        field,
        severity: Severity.ERROR,
        passed,
        whenPassed: 'Monetary total is present.',
        whenFailed: 'Monetary total is required for XRechnung.',
      }),
    );
  }

  return [...results, ...runPresenceRules(COMPLETENESS_RULES, parsed)];
}

const COMPLETENESS_LOOP_RULE_IDS = [
  SELLER_IDENTITY_RULE,
  BUYER_IDENTITY_RULE,
  PARTY_STREET_RULE,
  ELECTRONIC_ADDRESS_RULE,
  SELLER_CONTACT_RULE,
  LINE_VAT_RATE_OR_EXEMPTION_RULE,
  VAT_RATE_OR_EXEMPTION_RULE,
  MONETARY_TOTAL_RULE,
  VAT_CATEGORY_RULE,
  VAT_CATEGORY_REASON_RULE,
  VAT_CATEGORY_BUYER_IDENTITY_RULE,
  VAT_CATEGORY_SELLER_VAT_ID_RULE,
] as const;

export const COMPLETENESS_RULE_IDS: readonly string[] = [
  ...COMPLETENESS_RULES.map((rule) => rule.rule),
  ...COMPLETENESS_LOOP_RULE_IDS,
];
