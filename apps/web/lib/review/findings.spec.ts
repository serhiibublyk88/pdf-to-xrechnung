import { describe, expect, it } from 'vitest';
import {
  blockingFindings,
  dropStaleCollectionFindings,
  failedFindingsByField,
  fieldElementId,
  fieldInputId,
  ruleText,
  severityLabel,
  sortFindingsForDisplay,
} from './findings';
import { de } from '../i18n/de';
import type { InvoiceFinding } from '../api/schemas';

function finding(overrides: Partial<InvoiceFinding>): InvoiceFinding {
  return {
    rule: 'test.rule',
    field: null,
    severity: 'ERROR',
    passed: true,
    message: 'message',
    expected: null,
    actual: null,
    ...overrides,
  };
}

describe('sortFindingsForDisplay', () => {
  it('orders failed ERRORs before failed WARNINGs before passed findings', () => {
    const passed = finding({ rule: 'passed', passed: true, field: 'z' });
    const failedWarning = finding({
      rule: 'warn',
      passed: false,
      severity: 'WARNING',
      field: 'y',
    });
    const failedError = finding({
      rule: 'err',
      passed: false,
      severity: 'ERROR',
      field: 'x',
    });

    const sorted = sortFindingsForDisplay([passed, failedWarning, failedError]);

    expect(sorted.map((entry) => entry.rule)).toEqual([
      'err',
      'warn',
      'passed',
    ]);
  });

  it('groups adjacent findings within a bucket by field', () => {
    const a = finding({
      rule: 'a',
      passed: false,
      severity: 'ERROR',
      field: 'b',
    });
    const b = finding({
      rule: 'b',
      passed: false,
      severity: 'ERROR',
      field: 'a',
    });

    const sorted = sortFindingsForDisplay([a, b]);

    expect(sorted.map((entry) => entry.rule)).toEqual(['b', 'a']);
  });

  it('orders indexed paths numerically, not as strings', () => {
    const tenth = finding({
      rule: 'tenth',
      passed: false,
      severity: 'ERROR',
      field: 'lineItems[10].netAmount',
    });
    const second = finding({
      rule: 'second',
      passed: false,
      severity: 'ERROR',
      field: 'lineItems[2].netAmount',
    });

    const sorted = sortFindingsForDisplay([tenth, second]);

    expect(sorted.map((entry) => entry.rule)).toEqual(['second', 'tenth']);
  });

  it('does not mutate the input array', () => {
    const input = [finding({ rule: 'a' }), finding({ rule: 'b' })];
    const copy = [...input];

    sortFindingsForDisplay(input);

    expect(input).toEqual(copy);
  });
});

describe('failedFindingsByField', () => {
  it('keys only failed findings by the field they name', () => {
    const failed = finding({ passed: false, field: 'seller.vatId' });
    const findings = [
      failed,
      finding({ rule: 'passed', passed: true, field: 'buyer.vatId' }),
      finding({ rule: 'general', passed: false, field: null }),
    ];

    const byField = failedFindingsByField(findings);

    expect([...byField.keys()]).toEqual(['seller.vatId']);
    expect(byField.get('seller.vatId')).toEqual([failed]);
  });

  it('collects several findings on the same field', () => {
    const first = finding({ rule: 'a', passed: false, field: 'grossTotal' });
    const second = finding({ rule: 'b', passed: false, field: 'grossTotal' });

    expect(
      failedFindingsByField([first, second]).get('grossTotal'),
    ).toHaveLength(2);
  });
});

describe('blockingFindings', () => {
  it('keeps only failed ERRORs', () => {
    const findings = [
      finding({ rule: 'blocks', passed: false, severity: 'ERROR' }),
      finding({ rule: 'warns', passed: false, severity: 'WARNING' }),
      finding({ rule: 'ok', passed: true, severity: 'ERROR' }),
    ];

    expect(blockingFindings(findings).map((entry) => entry.rule)).toEqual([
      'blocks',
    ]);
  });
});

describe('ruleText', () => {
  it('looks up the German rule text from the dictionary', () => {
    const knownFinding = finding({ rule: 'mandatory.buyer_identity' });

    expect(ruleText(knownFinding, de)).toBe(
      de.rules['mandatory.buyer_identity'],
    );
  });

  it('falls back to the server message for a rule not in the catalogue', () => {
    const unknownFinding = finding({
      rule: 'not.a.real.rule',
      message: 'server-provided fallback text',
    });

    expect(ruleText(unknownFinding, de)).toBe('server-provided fallback text');
  });
});

describe('dropStaleCollectionFindings', () => {
  it('drops lineItems[…] findings once rows have been added or removed', () => {
    const stale = finding({
      rule: 'arithmetic.line_net',
      passed: false,
      field: 'lineItems[2].netAmount',
    });
    const untouched = finding({
      rule: 'mandatory.buyer_identity',
      passed: false,
      field: 'buyer.name',
    });
    const findings = [stale, untouched];
    const result = dropStaleCollectionFindings(findings, {
      lineItemsRestructured: true,
      vatBreakdownRestructured: false,
    });

    expect(result).toEqual([untouched]);
  });

  it('drops vatBreakdown[…] findings independently of lineItems', () => {
    const lineItemFinding = finding({
      passed: false,
      field: 'lineItems[0].netAmount',
    });
    const vatFinding = finding({
      passed: false,
      field: 'vatBreakdown[0].amount',
    });
    const result = dropStaleCollectionFindings([vatFinding, lineItemFinding], {
      lineItemsRestructured: false,
      vatBreakdownRestructured: true,
    });

    expect(result).toEqual([lineItemFinding]);
  });

  it('returns the same array reference when neither collection was restructured', () => {
    const findings = [finding({ passed: false })];

    const result = dropStaleCollectionFindings(findings, {
      lineItemsRestructured: false,
      vatBreakdownRestructured: false,
    });

    expect(result).toBe(findings);
  });
});

describe('severityLabel', () => {
  it('labels a missing-mandatory-field ERROR as required, not an error', () => {
    const missingField = finding({
      rule: 'mandatory.electronic_address',
      severity: 'ERROR',
      passed: false,
    });

    expect(severityLabel(missingField, de)).toBe(de.review.requiredLabel);
  });

  it('labels a non-mandatory ERROR as an error', () => {
    const wrongValue = finding({
      rule: 'arithmetic.gross',
      severity: 'ERROR',
      passed: false,
    });

    expect(severityLabel(wrongValue, de)).toBe(de.severity.ERROR);
  });

  it('leaves WARNING and INFO severities untouched regardless of rule name', () => {
    const warning = finding({
      rule: 'mandatory.party_street',
      severity: 'WARNING',
      passed: false,
    });

    expect(severityLabel(warning, de)).toBe(de.severity.WARNING);
  });
});

describe('fieldElementId', () => {
  it('replaces brackets and dots with hyphens', () => {
    expect(fieldElementId('lineItems[3].netAmount')).toBe(
      'field-lineItems-3--netAmount',
    );
  });

  it('leaves a bare field name intact', () => {
    expect(fieldElementId('invoiceNumber')).toBe('field-invoiceNumber');
  });

  it('derives the input id the blocking summary focuses', () => {
    expect(fieldInputId('grossTotal')).toBe('field-grossTotal-input');
  });
});
