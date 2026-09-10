import { Severity } from '@prisma/client';
import {
  bicHasValidFormat,
  ibanHasValidChecksum,
  isGermanPostalCode,
  isPlausibleEmail,
  isPlausiblePhone,
  leitwegIdHasValidChecksum,
  looksLikeLeitwegId,
  vatIdHasAllowedPrefix,
  vatIdHasValidChecksum,
  vatIdHasValidSyntax,
} from '@pdf-to-xrechnung/contracts';
import {
  parseCalendarDate,
  presenceFinding,
  runPresenceRules,
  type MonetaryAmount,
  type ParsedInvoice,
  type PresenceRule,
  type ValidationFinding,
} from './shared';
import {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCY_CODES,
} from '@pdf-to-xrechnung/contracts';

const VAT_ID_SYNTAX_RULE = 'format.vat_id_syntax';
const VAT_ID_CHECKSUM_RULE = 'format.vat_id_checksum';
const VAT_ID_PREFIX_RULE = 'format.vat_id_prefix';
const IBAN_CHECKSUM_RULE = 'format.iban_checksum';
const BIC_RULE = 'format.bic';
const CURRENCY_RULE = 'format.currency';
const LEITWEG_ID_CHECKSUM_RULE = 'format.leitweg_id_checksum';
const COUNTRY_CODE_RULE = 'format.country_code';
const POSTAL_CODE_DE_RULE = 'format.postal_code_de';
const EMAIL_RULE = 'format.email';
const PHONE_RULE = 'format.phone';
const CALENDAR_DATE_RULE = 'format.calendar_date';
const MONETARY_PRECISION_RULE = 'format.monetary_precision';

const FORMAT_RULES: readonly PresenceRule[] = [
  {
    rule: IBAN_CHECKSUM_RULE,
    field: 'sellerIban',
    severity: Severity.ERROR,
    evaluate: (parsed) => {
      const { sellerIban } = parsed.source;
      return sellerIban === null ? undefined : ibanHasValidChecksum(sellerIban);
    },
    whenPassed: 'IBAN checksum is valid.',
    whenFailed: 'IBAN checksum is invalid.',
  },
  {
    rule: BIC_RULE,
    field: 'sellerBic',
    severity: Severity.WARNING,
    evaluate: (parsed) => {
      const { sellerBic } = parsed.source;
      return sellerBic === null ? undefined : bicHasValidFormat(sellerBic);
    },
    whenPassed: 'BIC has the expected format.',
    whenFailed: 'BIC does not have the expected format.',
  },
  {
    rule: CURRENCY_RULE,
    field: 'currency',
    severity: Severity.ERROR,
    evaluate: (parsed) => {
      const { currency } = parsed.source;
      return currency === null
        ? undefined
        : SUPPORTED_CURRENCY_CODES.has(currency);
    },
    whenPassed: 'Currency is supported by the XRechnung profile.',
    whenFailed: 'Currency is not supported by the XRechnung profile.',
  },
  {
    rule: LEITWEG_ID_CHECKSUM_RULE,
    field: 'buyerReference',
    severity: Severity.WARNING,
    evaluate: (parsed) => {
      const { buyerReference } = parsed.source;
      if (buyerReference === null || !looksLikeLeitwegId(buyerReference)) {
        return undefined;
      }
      return leitwegIdHasValidChecksum(buyerReference);
    },
    whenPassed: 'Leitweg-ID checksum is valid.',
    whenFailed: 'Leitweg-ID checksum is invalid.',
  },
];

export function validateFormats(parsed: ParsedInvoice): ValidationFinding[] {
  const results: ValidationFinding[] = [];

  for (const [partyName, party] of [
    ['seller', parsed.source.seller],
    ['buyer', parsed.source.buyer],
  ] as const) {
    if (party.vatId !== null) {
      const field = `${partyName}.vatId`;
      const syntaxValid = vatIdHasValidSyntax(party.vatId);
      results.push(
        presenceFinding({
          rule: VAT_ID_SYNTAX_RULE,
          field,
          severity: Severity.ERROR,
          passed: syntaxValid,
          whenPassed: 'VAT ID has the expected basic format.',
          whenFailed:
            'VAT ID must contain a two-character country prefix and identifier.',
        }),
      );
      results.push(
        presenceFinding({
          rule: VAT_ID_PREFIX_RULE,
          field,
          severity: Severity.ERROR,
          passed: vatIdHasAllowedPrefix(party.vatId),
          whenPassed: 'VAT ID has an allowed country prefix.',
          whenFailed: 'VAT ID must start with an allowed country prefix.',
        }),
      );
      if (party.vatId.startsWith('DE') && syntaxValid) {
        results.push(
          presenceFinding({
            rule: VAT_ID_CHECKSUM_RULE,
            field,
            severity: Severity.ERROR,
            passed: vatIdHasValidChecksum(party.vatId),
            whenPassed: 'German VAT ID checksum is valid.',
            whenFailed: 'German VAT ID checksum is invalid.',
          }),
        );
      }
    }
    if (party.countryCode !== null) {
      const passed = SUPPORTED_COUNTRY_CODES.has(party.countryCode);
      results.push(
        presenceFinding({
          rule: COUNTRY_CODE_RULE,
          field: `${partyName}.countryCode`,
          severity: Severity.WARNING,
          passed,
          whenPassed: 'Country code is supported by the XRechnung profile.',
          whenFailed: 'Country code is not supported by the XRechnung profile.',
        }),
      );
    }
    if (party.countryCode === 'DE' && party.postalCode !== null) {
      const passed = isGermanPostalCode(party.postalCode);
      results.push(
        presenceFinding({
          rule: POSTAL_CODE_DE_RULE,
          field: `${partyName}.postalCode`,
          severity: Severity.WARNING,
          passed,
          whenPassed: 'German postal code has five digits.',
          whenFailed: 'German postal code must have five digits.',
        }),
      );
    }
    if (party.contactEmail !== null) {
      const passed = isPlausibleEmail(party.contactEmail);
      results.push(
        presenceFinding({
          rule: EMAIL_RULE,
          field: `${partyName}.contactEmail`,
          severity: Severity.WARNING,
          passed,
          whenPassed: 'Email address has a plausible format.',
          whenFailed: 'Email address does not have a plausible format.',
        }),
      );
    }
    if (party.contactPhone !== null) {
      const passed = isPlausiblePhone(party.contactPhone);
      results.push(
        presenceFinding({
          rule: PHONE_RULE,
          field: `${partyName}.contactPhone`,
          severity: Severity.WARNING,
          passed,
          whenPassed: 'Phone number has a plausible format.',
          whenFailed: 'Phone number does not have a plausible format.',
        }),
      );
    }
  }

  for (const [field, value] of [
    ['issueDate', parsed.source.issueDate],
    ['dueDate', parsed.source.dueDate],
    ['deliveryDate', parsed.source.deliveryDate],
  ] as const) {
    if (value === null) {
      continue;
    }
    const passed = parseCalendarDate(value) !== null;
    results.push(
      presenceFinding({
        rule: CALENDAR_DATE_RULE,
        field,
        severity: Severity.ERROR,
        passed,
        whenPassed: 'Date is a valid calendar date.',
        whenFailed: 'Date is not a valid calendar date.',
      }),
    );
  }

  return [...results, ...runPresenceRules(FORMAT_RULES, parsed)];
}

export function validateMonetaryPrecision(
  parsed: ParsedInvoice,
): ValidationFinding[] {
  const results: ValidationFinding[] = [];
  const amounts: Array<{ field: string; amount: MonetaryAmount }> = [
    { field: 'netTotal', amount: parsed.netTotal },
    { field: 'vatTotal', amount: parsed.vatTotal },
    { field: 'grossTotal', amount: parsed.grossTotal },
  ];

  for (const [index, lineItem] of parsed.lineItems.entries()) {
    amounts.push({
      field: `lineItems[${index}].netAmount`,
      amount: lineItem.netAmount,
    });
  }
  for (const [index, vatBreakdown] of parsed.vatBreakdown.entries()) {
    amounts.push({
      field: `vatBreakdown[${index}].base`,
      amount: vatBreakdown.base,
    });
    amounts.push({
      field: `vatBreakdown[${index}].amount`,
      amount: vatBreakdown.amount,
    });
  }

  for (const { field, amount } of amounts) {
    if (amount.decimal === null) {
      continue;
    }
    const passed = amount.minorUnits !== null;
    results.push({
      rule: MONETARY_PRECISION_RULE,
      field,
      severity: Severity.ERROR,
      passed,
      message: passed
        ? 'Monetary amount has at most two decimal places.'
        : 'Monetary amount has more than two decimal places.',
      expected: 'at most 2 decimal places',
      actual: `${amount.decimal.scale} decimal places`,
    });
  }

  return results;
}

const FORMAT_LOOP_RULE_IDS = [
  VAT_ID_SYNTAX_RULE,
  VAT_ID_PREFIX_RULE,
  VAT_ID_CHECKSUM_RULE,
  COUNTRY_CODE_RULE,
  POSTAL_CODE_DE_RULE,
  EMAIL_RULE,
  PHONE_RULE,
  CALENDAR_DATE_RULE,
  MONETARY_PRECISION_RULE,
] as const;

export const FORMAT_RULE_IDS: readonly string[] = [
  ...FORMAT_RULES.map((rule) => rule.rule),
  ...FORMAT_LOOP_RULE_IDS,
];
