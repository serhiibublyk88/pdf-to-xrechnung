import { Severity } from '@prisma/client';
import type {
  LineItem,
  RawExtractedInvoiceData,
  ValidationRuleCode,
  VatBreakdown,
} from '@pdf-to-xrechnung/contracts';
import {
  parseDecimalString,
  toMinorUnitsFromDecimal,
  type Decimal,
} from '../../money/decimal';

export interface ValidationFinding {
  rule: ValidationRuleCode;
  field: string | null;
  severity: Severity;
  passed: boolean;
  message: string;
  expected?: string;
  actual?: string;
}

export interface MonetaryAmount {
  decimal: Decimal | null;
  minorUnits: bigint | null;
}

interface ParsedLineItem {
  source: LineItem;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  netAmount: MonetaryAmount;
  vatRate: Decimal | null;
}

interface ParsedVatBreakdown {
  source: VatBreakdown;
  rate: Decimal | null;
  base: MonetaryAmount;
  amount: MonetaryAmount;
}

export interface ParsedInvoice {
  source: RawExtractedInvoiceData;
  lineItems: ParsedLineItem[];
  vatBreakdown: ParsedVatBreakdown[];
  netTotal: MonetaryAmount;
  vatTotal: MonetaryAmount;
  grossTotal: MonetaryAmount;
}

function parseOptionalDecimal(value: string | null): Decimal | null {
  return value === null ? null : parseDecimalString(value);
}

function parseMonetaryAmount(value: string | null): MonetaryAmount {
  if (value === null) {
    return { decimal: null, minorUnits: null };
  }

  const decimal = parseDecimalString(value);
  return {
    decimal,
    minorUnits: decimal.scale <= 2 ? toMinorUnitsFromDecimal(decimal) : null,
  };
}

export function parseInvoice(source: RawExtractedInvoiceData): ParsedInvoice {
  return {
    source,
    lineItems: source.lineItems.map((lineItem) => ({
      source: lineItem,
      quantity: parseOptionalDecimal(lineItem.quantity),
      unitPrice: parseOptionalDecimal(lineItem.unitPrice),
      netAmount: parseMonetaryAmount(lineItem.netAmount),
      vatRate: parseOptionalDecimal(lineItem.vatRate),
    })),
    vatBreakdown: source.vatBreakdown.map((vatBreakdown) => ({
      source: vatBreakdown,
      rate: parseOptionalDecimal(vatBreakdown.rate),
      base: parseMonetaryAmount(vatBreakdown.base),
      amount: parseMonetaryAmount(vatBreakdown.amount),
    })),
    netTotal: parseMonetaryAmount(source.netTotal),
    vatTotal: parseMonetaryAmount(source.vatTotal),
    grossTotal: parseMonetaryAmount(source.grossTotal),
  };
}

export function isPresent(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function formatMinorUnits(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const euros = absolute / 100n;
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${euros}.${cents}`;
}

export function sumMinorUnits(amounts: MonetaryAmount[]): bigint | null {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.minorUnits === null) {
      return null;
    }
    total += amount.minorUnits;
  }
  return total;
}

function isWithinTolerance(
  expected: bigint,
  actual: bigint,
  tolerance: bigint,
): boolean {
  const difference = expected - actual;
  const absolute = difference < 0n ? -difference : difference;
  return absolute <= tolerance;
}

export function arithmeticFinding({
  rule,
  field,
  expected,
  actual,
  tolerance,
  subject,
}: {
  rule: ValidationRuleCode;
  field: string;
  expected: bigint;
  actual: bigint;
  tolerance: bigint;
  subject: string;
}): ValidationFinding {
  const passed = isWithinTolerance(expected, actual, tolerance);
  return {
    rule,
    field,
    severity: Severity.ERROR,
    passed,
    message: passed
      ? `${subject} matches the expected amount.`
      : `${subject} does not match the expected amount.`,
    expected: formatMinorUnits(expected),
    actual: formatMinorUnits(actual),
  };
}

export function unavailableArithmeticFinding(
  rule: ValidationRuleCode,
  field: string,
  subject: string,
): ValidationFinding {
  return {
    rule,
    field,
    severity: Severity.ERROR,
    passed: false,
    message: `${subject} cannot be checked because a required amount is missing or has too many decimal places.`,
  };
}

export function presenceFinding({
  rule,
  field,
  severity,
  passed,
  whenPassed,
  whenFailed,
}: {
  rule: ValidationRuleCode;
  field: string;
  severity: Severity;
  passed: boolean;
  whenPassed: string;
  whenFailed: string;
}): ValidationFinding {
  return {
    rule,
    field,
    severity,
    passed,
    message: passed ? whenPassed : whenFailed,
  };
}

export function parseCalendarDate(value: string): Date | null {
  const [yearPart, monthPart, dayPart] = value.split('-');
  if (!yearPart || !monthPart || !dayPart) {
    return null;
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

export interface PresenceRule {
  rule: ValidationRuleCode;
  field: string;
  severity: Severity;
  evaluate: (parsed: ParsedInvoice) => boolean | undefined;
  whenPassed: string;
  whenFailed: string;
}

export function runPresenceRules(
  rules: readonly PresenceRule[],
  parsed: ParsedInvoice,
): ValidationFinding[] {
  const results: ValidationFinding[] = [];
  for (const rule of rules) {
    const passed = rule.evaluate(parsed);
    if (passed === undefined) {
      continue;
    }
    results.push(
      presenceFinding({
        rule: rule.rule,
        field: rule.field,
        severity: rule.severity,
        passed,
        whenPassed: rule.whenPassed,
        whenFailed: rule.whenFailed,
      }),
    );
  }
  return results;
}
