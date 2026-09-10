import { InvoiceStatus, Severity } from '@prisma/client';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';
import { validateArithmetic } from './rules/arithmetic';
import { validateCompleteness } from './rules/completeness';
import { validateFormats, validateMonetaryPrecision } from './rules/formats';
import { validatePlausibility } from './rules/plausibility';
import { parseInvoice, type ValidationFinding } from './rules/shared';

export type { ValidationFinding };

export function reviewRoutingStatus(
  findings: ValidationFinding[],
): typeof InvoiceStatus.NEEDS_REVIEW | typeof InvoiceStatus.GENERATING {
  return findings.some(
    (finding) => !finding.passed && finding.severity === Severity.ERROR,
  )
    ? InvoiceStatus.NEEDS_REVIEW
    : InvoiceStatus.GENERATING;
}

export function validateExtractedInvoice(
  source: unknown,
  validationDate: Date,
): ValidationFinding[] {
  const schemaResult = RawExtractedInvoiceDataSchema.safeParse(source);
  if (!schemaResult.success) {
    return [
      {
        rule: 'schema.extracted_data',
        field: null,
        severity: Severity.ERROR,
        passed: false,
        message:
          source === null || source === undefined
            ? 'No schema-valid extracted data is available for validation.'
            : 'Stored extracted data no longer matches the validation schema.',
      },
    ];
  }

  const parsed = parseInvoice(schemaResult.data);
  return [
    ...validateMonetaryPrecision(parsed),
    ...validateArithmetic(parsed),
    ...validateFormats(parsed),
    ...validateCompleteness(parsed),
    ...validatePlausibility(parsed, validationDate),
  ];
}
