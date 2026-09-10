import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE,
  type Env,
} from '../src/config/env.schema';
import { NativeTextExtractor } from '../src/extraction/native-text-extractor';
import {
  canonicalDecimalKey as decimalKey,
  percentageOfInMinorUnits as vatInMinorUnits,
  productInMinorUnits,
  toMinorUnits as minorUnits,
} from '../src/money/decimal';
import {
  GoldenFixtureSchema,
  type GoldenFixture,
} from './golden-fixture.schema';

const datasetRoot = join(__dirname, 'dataset');

function requiredFieldErrors(fixture: GoldenFixture): string[] {
  const { data } = fixture;
  const errors: string[] = [];

  if (!data.invoiceNumber) errors.push('mandatory.invoice_number');
  if (!data.issueDate) errors.push('mandatory.issue_date');
  if (!data.currency) errors.push('mandatory.currency');
  if (!data.grossTotal) errors.push('mandatory.gross_total');
  if (!data.seller.vatId && !data.seller.taxNumber) {
    errors.push('mandatory.seller_tax_id');
  }
  if (!data.buyerReference) errors.push('mandatory.buyer_reference');
  if (!data.dueDate && !data.paymentTerms) {
    errors.push('mandatory.payment_due_or_terms');
  }

  return errors.sort();
}

function validateCompleteness(
  fixture: GoldenFixture,
  report: (message: string) => void,
): void {
  const { data } = fixture;
  const commonParties = [
    ['seller', data.seller],
    ['buyer', data.buyer],
  ] as const;

  for (const [role, party] of commonParties) {
    if (!party.name || !party.street || !party.postalCode || !party.city) {
      report(`${role} identity or postal address is incomplete`);
    }
    if (!party.countryCode) report(`${role} country code is missing`);
  }

  if (
    data.seller.countryCode === 'DE' &&
    (!data.seller.contactName ||
      !data.seller.contactEmail ||
      !data.seller.contactPhone)
  ) {
    report('German seller contact name, email, and phone are required');
  }

  if (data.lineItems.length === 0) report('at least one line item is required');
  for (const [index, item] of data.lineItems.entries()) {
    if (
      !item.description ||
      item.quantity === null ||
      item.unitPrice === null ||
      item.netAmount === null ||
      item.vatRate === null
    ) {
      report(`line item ${index + 1} is incomplete`);
    }
    if (
      item.vatRate !== null &&
      decimalKey(item.vatRate) === '0' &&
      !item.vatExemptionReason
    ) {
      report(`line item ${index + 1} has zero VAT without a reason`);
    }
  }
}

function validateArithmetic(
  fixture: GoldenFixture,
  report: (message: string) => void,
): void {
  const { data } = fixture;
  let lineTotal = 0n;
  const linesByRate = new Map<string, bigint>();

  for (const [index, item] of data.lineItems.entries()) {
    if (
      item.quantity === null ||
      item.unitPrice === null ||
      item.netAmount === null
    ) {
      continue;
    }

    const actual = minorUnits(item.netAmount);
    const expected = productInMinorUnits(item.quantity, item.unitPrice);
    if (actual !== expected) {
      report(
        `line item ${index + 1} net amount does not match quantity × price`,
      );
    }
    lineTotal += actual;
    if (item.vatRate !== null) {
      const key = decimalKey(item.vatRate);
      linesByRate.set(key, (linesByRate.get(key) ?? 0n) + actual);
    }
  }

  if (data.netTotal !== null && lineTotal !== minorUnits(data.netTotal)) {
    report('net total does not equal the sum of line net amounts');
  }

  let breakdownBase = 0n;
  let breakdownVat = 0n;
  const breakdownRates = new Set<string>();
  for (const [index, entry] of data.vatBreakdown.entries()) {
    if (entry.rate === null || entry.base === null || entry.amount === null) {
      report(`VAT breakdown ${index + 1} is incomplete`);
      continue;
    }

    const key = decimalKey(entry.rate);
    const base = minorUnits(entry.base);
    const amount = minorUnits(entry.amount);
    breakdownRates.add(key);
    breakdownBase += base;
    breakdownVat += amount;

    if (linesByRate.get(key) !== base) {
      report(`VAT breakdown ${index + 1} base does not match its line items`);
    }
    if (vatInMinorUnits(entry.base, entry.rate) !== amount) {
      report(
        `VAT breakdown ${index + 1} amount is arithmetically inconsistent`,
      );
    }
    if (key === '0' && !entry.exemptionReason && !entry.category) {
      report(
        `VAT breakdown ${index + 1} has zero VAT without a category or reason`,
      );
    }
  }

  for (const rate of linesByRate.keys()) {
    if (!breakdownRates.has(rate)) report(`VAT rate ${rate} has no breakdown`);
  }
  if (data.netTotal !== null && breakdownBase !== minorUnits(data.netTotal)) {
    report('VAT bases do not equal the net total');
  }
  if (data.vatTotal !== null && breakdownVat !== minorUnits(data.vatTotal)) {
    report('VAT total does not equal the sum of VAT breakdown amounts');
  }
  if (
    data.netTotal !== null &&
    data.vatTotal !== null &&
    data.grossTotal !== null &&
    minorUnits(data.netTotal) + minorUnits(data.vatTotal) !==
      minorUnits(data.grossTotal)
  ) {
    report('gross total does not equal net total plus VAT total');
  }
}

function criticalText(fixture: GoldenFixture): string[] {
  const { data } = fixture;
  return [
    data.invoiceNumber,
    data.issueDate,
    data.dueDate,
    data.deliveryDate,
    data.netTotal,
    data.vatTotal,
    data.grossTotal,
    ...data.lineItems.flatMap((line) => [
      line.unitPrice,
      line.netAmount,
      line.vatRate,
    ]),
    ...data.vatBreakdown.flatMap((entry) => [
      entry.rate,
      entry.base,
      entry.amount,
    ]),
  ].filter((value): value is string => value !== null);
}

async function validateRenderedPdf(
  fixture: GoldenFixture,
  pdfPath: string,
  report: (message: string) => void,
): Promise<void> {
  const config = new ConfigService<Env, true>({
    NATIVE_TEXT_TIMEOUT_MS: 30_000,
    MAX_PAGES: 30,
    MAX_EXTRACTED_TEXT_CHARS: 500_000,
  });
  const extractor = new NativeTextExtractor(config);
  const extracted = await extractor.extract(readFileSync(pdfPath));
  if (extracted.pageCount !== fixture.meta.pages) {
    report(
      `rendered PDF has ${extracted.pageCount} pages, expected ${fixture.meta.pages}`,
    );
  }
  if (fixture.meta.sourceType === 'ocr') {
    for (const page of extracted.pages) {
      if (page.charCount >= DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE) {
        report(
          `scan page ${page.pageNumber} has ${page.charCount} native characters, expected fewer than ${DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE}`,
        );
      }
    }
    return;
  }
  for (const value of criticalText(fixture)) {
    if (!extracted.text.includes(value)) {
      report(
        `rendered PDF does not contain critical value ${JSON.stringify(value)}`,
      );
    }
  }
}

const caseDirectories = readdirSync(datasetRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const failures: string[] = [];

async function main(): Promise<void> {
  for (const caseDirectory of caseDirectories) {
    const caseRoot = join(datasetRoot, caseDirectory);
    const groundTruthPath = join(caseRoot, 'ground-truth.json');
    const pdfPath = join(caseRoot, 'invoice.pdf');
    const report = (message: string): void => {
      failures.push(`${caseDirectory}: ${message}`);
    };

    if (!existsSync(groundTruthPath)) {
      report('ground-truth.json is missing');
      continue;
    }
    if (!existsSync(pdfPath)) {
      report('invoice.pdf is missing');
      continue;
    }

    let fixture: GoldenFixture;
    try {
      const source: unknown = JSON.parse(readFileSync(groundTruthPath, 'utf8'));
      fixture = GoldenFixtureSchema.parse(source);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (fixture.meta.id !== caseDirectory)
      report('meta.id differs from directory');
    if (fixture.meta.pages < 1) report('page count must be positive');

    if (fixture.meta.expectedOutcome === 'success') {
      try {
        validateCompleteness(fixture, report);
        validateArithmetic(fixture, report);
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    }

    const expectedErrors = [...fixture.meta.expectedErrors].sort();
    if (fixture.meta.expectedOutcome !== 'failed') {
      const actualErrors = requiredFieldErrors(fixture);
      if (JSON.stringify(actualErrors) !== JSON.stringify(expectedErrors)) {
        report(
          `expectedErrors ${JSON.stringify(expectedErrors)} do not match ${JSON.stringify(actualErrors)}`,
        );
      }
    }
    if (
      fixture.meta.expectedOutcome === 'success' &&
      expectedErrors.length > 0
    ) {
      report('successful fixture declares validation errors');
    }
    if (
      fixture.meta.expectedOutcome === 'failed' &&
      expectedErrors.length > 0
    ) {
      report('failed fixture declares validation errors');
    }
    await validateRenderedPdf(fixture, pdfPath, report);
  }

  if (caseDirectories.length === 0)
    failures.push('dataset contains no fixtures');
  if (failures.length > 0) {
    throw new Error(`Golden-set validation failed:\n${failures.join('\n')}`);
  }

  process.stdout.write(`Validated ${caseDirectories.length} golden fixtures\n`);
}

void main();
