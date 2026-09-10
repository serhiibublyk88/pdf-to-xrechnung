import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as rootExports from './index';
import type {
  InvoiceFailure,
  LineItem,
  Party,
  RawExtractedInvoiceData,
  ReviewResult,
  VatBreakdown,
} from './index';

const workspaceRoot = path.resolve(__dirname, '../../..');

function runNode(script: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? '', status: failure.status ?? 1 };
  }
}

const expectedRuntimeExports = [
  'ibanHasValidChecksum',
  'vatIdHasAllowedPrefix',
  'vatIdHasValidChecksum',
  'vatIdHasValidSyntax',
  'isGermanPostalCode',
  'CURRENCY_CODES',
  'REJECTED_BY_KOSIT_CURRENCY_CODES',
  'SUPPORTED_CURRENCY_CODES',
  'COUNTRY_CODES',
  'SUPPORTED_COUNTRY_CODES',
  'UN_ECE_UNIT_CODES',
  'UNIT_OPTIONS',
  'resolveUnitCode',
  'ELECTRONIC_ADDRESS_SCHEMES',
  'SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES',
  'IMPLIED_VAT_EXEMPTION_REASON_CODES',
  'VAT_CATEGORIES_REQUIRING_FREE_TEXT_REASON',
  'VAT_CATEGORY_CODES',
  'isPlausibleEmail',
  'isPlausiblePhone',
  'bicHasValidFormat',
  'leitwegIdHasValidChecksum',
  'looksLikeLeitwegId',
  'INVOICE_FAILURE_CODES',
  'InvoiceFailureSchema',
  'canonicalDecimalPattern',
  'countryCodePattern',
  'currencyCodePattern',
  'isoDatePattern',
  'LineItemSchema',
  'PartySchema',
  'RawExtractedInvoiceDataSchema',
  'ReviewResultSchema',
  'VatBreakdownSchema',
  'lifecycleTokenPattern',
  'MAX_DECIMAL_LENGTH',
  'MAX_LINE_ITEMS',
  'MAX_TEXT_LENGTH',
  'MAX_VAT_BREAKDOWNS',
  'MAX_VAT_ID_LENGTH',
].sort();

function assertRootTypeSurface(surface: {
  invoiceFailure: InvoiceFailure;
  lineItem: LineItem;
  party: Party;
  rawExtractedInvoiceData: RawExtractedInvoiceData;
  reviewResult: ReviewResult;
  vatBreakdown: VatBreakdown;
}): void {
  void surface;
}

describe('package root (./index)', () => {
  it('exposes exactly the intended runtime surface, no more and no less', () => {
    expect(Object.keys(rootExports).sort()).toEqual(expectedRuntimeExports);
  });

  it('keeps the type-only exports available from the root', () => {
    expect(assertRootTypeSurface).toBeInstanceOf(Function);
  });
});

describe('real Node package resolution (installed Node, not a Jest module map)', () => {
  it('resolves the package root through CommonJS require', () => {
    const result = runNode(
      "console.log(typeof require('@pdf-to-xrechnung/contracts').ibanHasValidChecksum)",
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('resolves the package root through native ESM import', () => {
    const result = runNode(
      "import('@pdf-to-xrechnung/contracts').then((m) => console.log(typeof m.ibanHasValidChecksum))",
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('rejects an internal dist subpath with ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    const result = runNode(
      "try { require('@pdf-to-xrechnung/contracts/dist/checksums.js'); console.log('resolved'); } catch (error) { console.log(error.code); }",
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
