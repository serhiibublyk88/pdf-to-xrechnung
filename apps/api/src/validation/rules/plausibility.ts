import { Severity } from '@prisma/client';
import { canonicalDecimalKeyFromDecimal } from '../../money/decimal';
import {
  isPresent,
  parseCalendarDate,
  presenceFinding,
  runPresenceRules,
  type ParsedInvoice,
  type PresenceRule,
  type ValidationFinding,
} from './shared';

const DATE_RANGE_RULE = 'plausible.date_range';
const DATE_ORDER_RULE = 'plausible.date_order';
const POSITIVE_AMOUNTS_RULE = 'plausible.positive_amounts';
const LINE_COUNT_RULE = 'plausible.line_count';
const MAGNITUDE_RULE = 'plausible.magnitude';
const VAT_RATE_RULE = 'plausible.vat_rate';
const ZERO_VAT_REASON_RULE = 'plausible.zero_vat_reason';

function issueDateOf(parsed: ParsedInvoice): Date | null {
  return parsed.source.issueDate === null
    ? null
    : parseCalendarDate(parsed.source.issueDate);
}

function deliveryDateOf(parsed: ParsedInvoice): Date | null {
  return parsed.source.deliveryDate === null
    ? null
    : parseCalendarDate(parsed.source.deliveryDate);
}

function buildPlausibilityRules(validationDate: Date): readonly PresenceRule[] {
  return [
    {
      rule: DATE_RANGE_RULE,
      field: 'issueDate',
      severity: Severity.WARNING,
      evaluate: (parsed) => {
        const issueDate = issueDateOf(parsed);
        if (issueDate === null) {
          return undefined;
        }
        const earliest = new Date(
          Date.UTC(
            validationDate.getUTCFullYear() - 10,
            validationDate.getUTCMonth(),
            validationDate.getUTCDate(),
          ),
        );
        const latest = new Date(
          Date.UTC(
            validationDate.getUTCFullYear() + 1,
            validationDate.getUTCMonth(),
            validationDate.getUTCDate(),
          ),
        );
        return issueDate >= earliest && issueDate <= latest;
      },
      whenPassed: 'Invoice issue date is within the supported range.',
      whenFailed: 'Invoice issue date is outside the supported range.',
    },
    {
      rule: DATE_ORDER_RULE,
      field: 'deliveryDate',
      severity: Severity.WARNING,
      evaluate: (parsed) => {
        const issueDate = issueDateOf(parsed);
        const deliveryDate = deliveryDateOf(parsed);
        if (issueDate === null || deliveryDate === null) {
          return undefined;
        }
        return deliveryDate <= issueDate;
      },
      whenPassed: 'Delivery date is not after the invoice issue date.',
      whenFailed: 'Delivery date is after the invoice issue date.',
    },
    {
      rule: POSITIVE_AMOUNTS_RULE,
      field: 'totals',
      severity: Severity.WARNING,
      evaluate: (parsed) => {
        const { netTotal, vatTotal, grossTotal } = parsed;
        if (
          netTotal.minorUnits === null ||
          vatTotal.minorUnits === null ||
          grossTotal.minorUnits === null
        ) {
          return undefined;
        }
        return (
          netTotal.minorUnits >= 0n &&
          vatTotal.minorUnits >= 0n &&
          grossTotal.minorUnits >= 0n
        );
      },
      whenPassed: 'Totals are non-negative.',
      whenFailed: 'Negative totals are not supported for v1 invoices.',
    },
    {
      rule: LINE_COUNT_RULE,
      field: 'lineItems',
      severity: Severity.ERROR,
      evaluate: (parsed) => parsed.lineItems.length > 0,
      whenPassed: 'At least one line item is present.',
      whenFailed: 'At least one line item is required.',
    },
    {
      rule: MAGNITUDE_RULE,
      field: 'grossTotal',
      severity: Severity.WARNING,
      evaluate: (parsed) => {
        const { grossTotal } = parsed;
        return grossTotal.minorUnits === null
          ? undefined
          : grossTotal.minorUnits < 1_000_000_000n;
      },
      whenPassed: 'Gross total is below the supported magnitude limit.',
      whenFailed: 'Gross total is at or above the supported magnitude limit.',
    },
  ];
}

export function validatePlausibility(
  parsed: ParsedInvoice,
  validationDate: Date,
): ValidationFinding[] {
  const results: ValidationFinding[] = [];

  for (const [index, vatBreakdown] of parsed.vatBreakdown.entries()) {
    if (vatBreakdown.rate === null) {
      continue;
    }
    const rateKey = canonicalDecimalKeyFromDecimal(vatBreakdown.rate);
    const passed = rateKey === '19:0' || rateKey === '7:0' || rateKey === '0';
    results.push(
      presenceFinding({
        rule: VAT_RATE_RULE,
        field: `vatBreakdown[${index}].rate`,
        severity: Severity.WARNING,
        passed,
        whenPassed: 'VAT rate is one of the supported standard rates.',
        whenFailed: 'VAT rate is outside the supported standard rates.',
      }),
    );
    if (rateKey === '0') {
      const exemptionPassed = isPresent(vatBreakdown.source.exemptionReason);
      results.push(
        presenceFinding({
          rule: ZERO_VAT_REASON_RULE,
          field: `vatBreakdown[${index}].exemptionReason`,
          severity: Severity.WARNING,
          passed: exemptionPassed,
          whenPassed: 'Zero VAT rate has an exemption reason.',
          whenFailed: 'Zero VAT rate has no exemption reason.',
        }),
      );
    }
  }

  return [
    ...results,
    ...runPresenceRules(buildPlausibilityRules(validationDate), parsed),
  ];
}

const PLAUSIBILITY_LOOP_RULE_IDS = [
  VAT_RATE_RULE,
  ZERO_VAT_REASON_RULE,
] as const;

export const PLAUSIBILITY_RULE_IDS: readonly string[] = [
  DATE_RANGE_RULE,
  DATE_ORDER_RULE,
  POSITIVE_AMOUNTS_RULE,
  LINE_COUNT_RULE,
  MAGNITUDE_RULE,
  ...PLAUSIBILITY_LOOP_RULE_IDS,
];
