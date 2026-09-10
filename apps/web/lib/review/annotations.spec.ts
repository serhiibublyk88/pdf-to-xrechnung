import { describe, expect, it } from 'vitest';
import {
  annotationsFor,
  groupIssuesByField,
  hasAnyAnnotation,
  type FieldAnnotations,
} from './annotations';
import type { FieldIssue } from './draft';
import type { InvoiceFinding } from '../api/schemas';

function findingOf(overrides: Partial<InvoiceFinding> = {}): InvoiceFinding {
  return {
    rule: 'format.leitweg_id_checksum',
    field: 'buyerReference',
    severity: 'WARNING',
    passed: false,
    message: 'Die Prüfziffer der Leitweg-ID stimmt nicht.',
    expected: null,
    actual: null,
    ...overrides,
  };
}

function annotationsOf(
  overrides: Partial<FieldAnnotations> = {},
): FieldAnnotations {
  return {
    findings: new Map(),
    issues: new Map(),
    changedPaths: new Set(),
    ...overrides,
  };
}

describe('annotationsFor', () => {
  it('drops a client issue that mirrors an already-failing untouched server rule', () => {
    const issue: FieldIssue = {
      path: 'buyerReference',
      code: 'leitwegIdChecksum',
      blocking: false,
    };
    const annotations = annotationsOf({
      findings: new Map([['buyerReference', [findingOf()]]]),
      issues: groupIssuesByField([issue]),
    });

    expect(annotationsFor(annotations, 'buyerReference').issues).toEqual([]);
  });

  it('keeps the client issue once the field has been edited since load', () => {
    const issue: FieldIssue = {
      path: 'buyerReference',
      code: 'leitwegIdChecksum',
      blocking: false,
    };
    const annotations = annotationsOf({
      findings: new Map([['buyerReference', [findingOf()]]]),
      issues: groupIssuesByField([issue]),
      changedPaths: new Set(['buyerReference']),
    });

    expect(annotationsFor(annotations, 'buyerReference').issues).toEqual([
      issue,
    ]);
  });

  it('keeps a client issue with no server-rule counterpart even when untouched', () => {
    const issue: FieldIssue = {
      path: 'netTotal',
      code: 'thousandsSeparator',
      blocking: false,
    };
    const annotations = annotationsOf({
      issues: groupIssuesByField([issue]),
    });

    expect(annotationsFor(annotations, 'netTotal').issues).toEqual([issue]);
  });

  it("keeps a client issue whose mirrored rule is not among this field's findings", () => {
    const issue: FieldIssue = {
      path: 'sellerIban',
      code: 'ibanChecksum',
      blocking: false,
    };
    const annotations = annotationsOf({
      issues: groupIssuesByField([issue]),
    });

    expect(annotationsFor(annotations, 'sellerIban').issues).toEqual([issue]);
  });

  it('always passes findings through untouched', () => {
    const finding = findingOf();
    const annotations = annotationsOf({
      findings: new Map([['buyerReference', [finding]]]),
    });

    expect(annotationsFor(annotations, 'buyerReference').findings).toEqual([
      finding,
    ]);
  });
});

describe('hasAnyAnnotation', () => {
  it('still reports a field whose only client issue was deduplicated away', () => {
    const annotations = annotationsOf({
      findings: new Map([['buyerReference', [findingOf()]]]),
    });

    expect(hasAnyAnnotation(annotations, ['buyerReference'])).toBe(true);
  });
});
