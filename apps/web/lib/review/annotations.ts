import type { InvoiceFinding } from '@/lib/api/schemas';
import { MIRRORED_RULE, type FieldIssue } from './draft';

export interface FieldAnnotations {
  findings: ReadonlyMap<string, InvoiceFinding[]>;
  issues: ReadonlyMap<string, FieldIssue[]>;
  changedPaths: ReadonlySet<string>;
}

export function groupIssuesByField(
  issues: FieldIssue[],
): ReadonlyMap<string, FieldIssue[]> {
  const byField = new Map<string, FieldIssue[]>();
  for (const issue of issues) {
    const existing = byField.get(issue.path);
    if (existing) existing.push(issue);
    else byField.set(issue.path, [issue]);
  }
  return byField;
}

export function annotationsFor(
  annotations: FieldAnnotations,
  path: string,
): { findings: InvoiceFinding[]; issues: FieldIssue[] } {
  const findings = annotations.findings.get(path) ?? [];
  const issues = annotations.issues.get(path) ?? [];
  if (annotations.changedPaths.has(path)) {
    return { findings, issues };
  }

  const failedRules = new Set(findings.map((finding) => finding.rule));
  return {
    findings,
    issues: issues.filter((issue) => {
      const mirroredRule = MIRRORED_RULE[issue.code];
      return mirroredRule === undefined || !failedRules.has(mirroredRule);
    }),
  };
}

export function hasAnyAnnotation(
  annotations: FieldAnnotations,
  paths: string[],
): boolean {
  return paths.some(
    (path) => annotations.findings.has(path) || annotations.issues.has(path),
  );
}
