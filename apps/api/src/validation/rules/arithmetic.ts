import {
  percentageOfDecimalsInMinorUnits,
  productDecimalsInMinorUnits,
} from '../../money/decimal';
import {
  arithmeticFinding,
  sumMinorUnits,
  unavailableArithmeticFinding,
  type ParsedInvoice,
  type ValidationFinding,
} from './shared';

const LINE_NET_RULE = 'arithmetic.line_net';
const LINE_SUM_RULE = 'arithmetic.line_sum';
const VAT_BASE_SUM_RULE = 'arithmetic.vat_base_sum';
const VAT_AMOUNT_RULE = 'arithmetic.vat_amount';
const VAT_TOTAL_RULE = 'arithmetic.vat_total';
const GROSS_RULE = 'arithmetic.gross';

export function validateArithmetic(parsed: ParsedInvoice): ValidationFinding[] {
  const results: ValidationFinding[] = [];

  for (const [index, lineItem] of parsed.lineItems.entries()) {
    if (
      lineItem.quantity === null ||
      lineItem.unitPrice === null ||
      lineItem.netAmount.minorUnits === null
    ) {
      results.push(
        unavailableArithmeticFinding(
          LINE_NET_RULE,
          `lineItems[${index}].netAmount`,
          `Line ${index + 1} net amount`,
        ),
      );
      continue;
    }
    results.push(
      arithmeticFinding({
        rule: LINE_NET_RULE,
        field: `lineItems[${index}].netAmount`,
        expected: productDecimalsInMinorUnits(
          lineItem.quantity,
          lineItem.unitPrice,
        ),
        actual: lineItem.netAmount.minorUnits,
        tolerance: 1n,
        subject: `Line ${index + 1} net amount`,
      }),
    );
  }

  const lineSum = sumMinorUnits(
    parsed.lineItems.map((lineItem) => lineItem.netAmount),
  );
  if (lineSum === null || parsed.netTotal.minorUnits === null) {
    results.push(
      unavailableArithmeticFinding(LINE_SUM_RULE, 'netTotal', 'Net total'),
    );
  } else {
    results.push(
      arithmeticFinding({
        rule: LINE_SUM_RULE,
        field: 'netTotal',
        expected: lineSum,
        actual: parsed.netTotal.minorUnits,
        tolerance: 1n,
        subject: 'Net total',
      }),
    );
  }

  const vatBaseSum = sumMinorUnits(
    parsed.vatBreakdown.map((vatBreakdown) => vatBreakdown.base),
  );
  if (vatBaseSum === null || parsed.netTotal.minorUnits === null) {
    results.push(
      unavailableArithmeticFinding(VAT_BASE_SUM_RULE, 'netTotal', 'VAT bases'),
    );
  } else {
    results.push(
      arithmeticFinding({
        rule: VAT_BASE_SUM_RULE,
        field: 'netTotal',
        expected: vatBaseSum,
        actual: parsed.netTotal.minorUnits,
        tolerance: 1n,
        subject: 'VAT bases',
      }),
    );
  }

  for (const [index, vatBreakdown] of parsed.vatBreakdown.entries()) {
    if (
      vatBreakdown.base.decimal === null ||
      vatBreakdown.base.minorUnits === null ||
      vatBreakdown.rate === null ||
      vatBreakdown.amount.minorUnits === null
    ) {
      results.push(
        unavailableArithmeticFinding(
          VAT_AMOUNT_RULE,
          `vatBreakdown[${index}].amount`,
          `VAT amount for breakdown ${index + 1}`,
        ),
      );
      continue;
    }
    results.push(
      arithmeticFinding({
        rule: VAT_AMOUNT_RULE,
        field: `vatBreakdown[${index}].amount`,
        expected: percentageOfDecimalsInMinorUnits(
          vatBreakdown.base.decimal,
          vatBreakdown.rate,
        ),
        actual: vatBreakdown.amount.minorUnits,
        tolerance: 1n,
        subject: `VAT amount for breakdown ${index + 1}`,
      }),
    );
  }

  const vatAmountSum = sumMinorUnits(
    parsed.vatBreakdown.map((vatBreakdown) => vatBreakdown.amount),
  );
  if (vatAmountSum === null || parsed.vatTotal.minorUnits === null) {
    results.push(
      unavailableArithmeticFinding(VAT_TOTAL_RULE, 'vatTotal', 'VAT total'),
    );
  } else {
    results.push(
      arithmeticFinding({
        rule: VAT_TOTAL_RULE,
        field: 'vatTotal',
        expected: vatAmountSum,
        actual: parsed.vatTotal.minorUnits,
        tolerance: 1n,
        subject: 'VAT total',
      }),
    );
  }

  if (
    parsed.netTotal.minorUnits === null ||
    parsed.vatTotal.minorUnits === null ||
    parsed.grossTotal.minorUnits === null
  ) {
    results.push(
      unavailableArithmeticFinding(GROSS_RULE, 'grossTotal', 'Gross total'),
    );
  } else {
    results.push(
      arithmeticFinding({
        rule: GROSS_RULE,
        field: 'grossTotal',
        expected: parsed.netTotal.minorUnits + parsed.vatTotal.minorUnits,
        actual: parsed.grossTotal.minorUnits,
        tolerance: 0n,
        subject: 'Gross total',
      }),
    );
  }

  return results;
}

export const ARITHMETIC_RULE_IDS = [
  LINE_NET_RULE,
  LINE_SUM_RULE,
  VAT_BASE_SUM_RULE,
  VAT_AMOUNT_RULE,
  VAT_TOTAL_RULE,
  GROSS_RULE,
] as const;
