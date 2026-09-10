import {
  RawExtractedInvoiceDataSchema,
  type RawExtractedInvoiceData,
} from '@pdf-to-xrechnung/contracts';
import { canonicalDecimalKey } from '../src/money/decimal';
import type { GoldenFixture } from './golden-fixture.schema';

export interface Metric {
  matched: number;
  total: number;
}

export interface CaseComparison {
  critical: Metric;
  important: Metric;
  lineCountMatched: boolean;
  lineFields: Metric;
  mismatches: string[];
}

function blankMetric(): Metric {
  return { matched: 0, total: 0 };
}

function normalized(value: string | null): string | null {
  return value === null
    ? null
    : value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameValue(
  expected: string | null,
  actual: string | null,
  decimal = false,
): boolean {
  if (expected === null || actual === null) return expected === actual;
  return decimal
    ? canonicalDecimalKey(expected) === canonicalDecimalKey(actual)
    : normalized(expected) === normalized(actual);
}

function compare(
  metric: Metric,
  mismatches: string[],
  caseId: string,
  field: string,
  expected: string | null,
  actual: string | null,
  decimal = false,
): void {
  metric.total += 1;
  if (sameValue(expected, actual, decimal)) {
    metric.matched += 1;
    return;
  }
  mismatches.push(
    `${caseId} ${field}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`,
  );
}

function compareParty(
  expected: RawExtractedInvoiceData,
  actual: RawExtractedInvoiceData,
  comparison: CaseComparison,
  caseId: string,
): void {
  for (const role of ['seller', 'buyer'] as const) {
    for (const field of [
      'name',
      'street',
      'postalCode',
      'city',
      'countryCode',
      'vatId',
      'taxNumber',
      'electronicAddress',
      'electronicAddressScheme',
      'contactName',
      'contactEmail',
      'contactPhone',
    ] as const) {
      compare(
        comparison.important,
        comparison.mismatches,
        caseId,
        `${role}.${field}`,
        expected[role][field],
        actual[role][field],
      );
    }
  }
  for (const field of ['sellerIban', 'sellerBic'] as const) {
    compare(
      comparison.important,
      comparison.mismatches,
      caseId,
      field,
      expected[field],
      actual[field],
    );
  }
}

const DECIMAL_LINE_FIELDS = new Set([
  'quantity',
  'unitPrice',
  'netAmount',
  'vatRate',
]);

export function compareFixture(
  fixture: GoldenFixture,
  extracted: unknown,
): CaseComparison {
  const actual = RawExtractedInvoiceDataSchema.parse(extracted);
  const expected = fixture.data;
  const comparison: CaseComparison = {
    critical: blankMetric(),
    important: blankMetric(),
    lineCountMatched: expected.lineItems.length === actual.lineItems.length,
    lineFields: blankMetric(),
    mismatches: [],
  };

  for (const field of ['invoiceNumber', 'issueDate', 'currency'] as const) {
    compare(
      comparison.critical,
      comparison.mismatches,
      fixture.meta.id,
      field,
      expected[field],
      actual[field],
    );
  }
  for (const field of ['netTotal', 'vatTotal', 'grossTotal'] as const) {
    compare(
      comparison.critical,
      comparison.mismatches,
      fixture.meta.id,
      field,
      expected[field],
      actual[field],
      true,
    );
  }
  for (const field of [
    'dueDate',
    'deliveryDate',
    'paymentTerms',
    'buyerReference',
  ] as const) {
    compare(
      comparison.important,
      comparison.mismatches,
      fixture.meta.id,
      field,
      expected[field],
      actual[field],
    );
  }
  const vatEntries = Math.max(
    expected.vatBreakdown.length,
    actual.vatBreakdown.length,
  );
  for (let index = 0; index < vatEntries; index++) {
    const expectedEntry = expected.vatBreakdown[index] ?? null;
    const actualEntry = actual.vatBreakdown[index] ?? null;
    for (const field of ['rate', 'base', 'amount'] as const) {
      compare(
        comparison.critical,
        comparison.mismatches,
        fixture.meta.id,
        `vatBreakdown[${index}].${field}`,
        expectedEntry?.[field] ?? null,
        actualEntry?.[field] ?? null,
        true,
      );
    }
    compare(
      comparison.important,
      comparison.mismatches,
      fixture.meta.id,
      `vatBreakdown[${index}].exemptionReason`,
      expectedEntry?.exemptionReason ?? null,
      actualEntry?.exemptionReason ?? null,
    );
  }
  compareParty(expected, actual, comparison, fixture.meta.id);

  for (
    let index = 0;
    index < Math.min(expected.lineItems.length, actual.lineItems.length);
    index++
  ) {
    const expectedLine = expected.lineItems[index];
    const actualLine = actual.lineItems[index];
    if (!expectedLine || !actualLine) continue;
    for (const field of [
      'position',
      'description',
      'quantity',
      'unit',
      'unitPrice',
      'netAmount',
      'vatRate',
      'vatExemptionReason',
    ] as const) {
      compare(
        comparison.lineFields,
        comparison.mismatches,
        fixture.meta.id,
        `lineItems[${index}].${field}`,
        expectedLine[field] === null ? null : String(expectedLine[field]),
        actualLine[field] === null ? null : String(actualLine[field]),
        DECIMAL_LINE_FIELDS.has(field),
      );
    }
  }
  return comparison;
}

export function addMetrics(target: Metric, source: Metric): void {
  target.matched += source.matched;
  target.total += source.total;
}
