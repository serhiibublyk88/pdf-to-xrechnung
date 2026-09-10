import type { Dictionary } from '@/lib/i18n/dictionary';
import type { InvoiceFinding } from '@/lib/api/schemas';

function bucketOrder(finding: InvoiceFinding): number {
  if (!finding.passed && finding.severity === 'ERROR') return 0;
  if (!finding.passed && finding.severity === 'WARNING') return 1;
  if (!finding.passed) return 2;
  return 3;
}

export function sortFindingsForDisplay(
  findings: InvoiceFinding[],
): InvoiceFinding[] {
  return [...findings].sort((a, b) => {
    const bucketDiff = bucketOrder(a) - bucketOrder(b);
    if (bucketDiff !== 0) return bucketDiff;
    return (a.field ?? '').localeCompare(b.field ?? '', undefined, {
      numeric: true,
    });
  });
}

export function blockingFindings(findings: InvoiceFinding[]): InvoiceFinding[] {
  return findings.filter(
    (finding) => !finding.passed && finding.severity === 'ERROR',
  );
}

export function failedFindingsByField(
  findings: InvoiceFinding[],
): ReadonlyMap<string, InvoiceFinding[]> {
  const byField = new Map<string, InvoiceFinding[]>();
  const failed = findings.filter((finding) => !finding.passed);
  for (const finding of sortFindingsForDisplay(failed)) {
    if (!finding.field) continue;
    const existing = byField.get(finding.field);
    if (existing) existing.push(finding);
    else byField.set(finding.field, [finding]);
  }
  return byField;
}

export function severityLabel(
  finding: InvoiceFinding,
  dictionary: Dictionary,
): string {
  if (finding.severity === 'ERROR' && finding.rule.startsWith('mandatory.')) {
    return dictionary.review.requiredLabel;
  }
  return dictionary.severity[finding.severity];
}

export function dropStaleCollectionFindings(
  findings: InvoiceFinding[],
  {
    lineItemsRestructured,
    vatBreakdownRestructured,
  }: { lineItemsRestructured: boolean; vatBreakdownRestructured: boolean },
): InvoiceFinding[] {
  if (!lineItemsRestructured && !vatBreakdownRestructured) return findings;
  return findings.filter((finding) => {
    if (lineItemsRestructured && finding.field?.startsWith('lineItems['))
      return false;
    if (vatBreakdownRestructured && finding.field?.startsWith('vatBreakdown['))
      return false;
    return true;
  });
}

export function ruleText(
  finding: InvoiceFinding,
  dictionary: Dictionary,
): string {
  const rules: Record<string, string | undefined> = dictionary.rules;
  return rules[finding.rule] ?? finding.message;
}

export function fieldElementId(field: string): string {
  return `field-${field.replace(/[[\].]/g, '-')}`;
}

export function fieldInputId(field: string): string {
  return `${fieldElementId(field)}-input`;
}

export function fieldMessageId(field: string): string {
  return `${fieldElementId(field)}-message`;
}
