import { describe, expect, it } from 'vitest';
import { resolvePipeline, stageIds } from './stages';
import type { InvoiceFinding } from '../api/schemas';

function finding(overrides: Partial<InvoiceFinding>): InvoiceFinding {
  return {
    rule: 'arithmetic.gross',
    field: 'grossTotal',
    severity: 'ERROR',
    passed: false,
    message: 'message',
    expected: null,
    actual: null,
    ...overrides,
  };
}

function statesOf(status: Parameters<typeof resolvePipeline>[0]['status']) {
  return resolvePipeline({ status }).stages.map((stage) => stage.state);
}

describe('resolvePipeline', () => {
  it('marks everything done at READY', () => {
    expect(statesOf('READY')).toEqual(stageIds.map(() => 'done'));
  });

  it('collapses a worker-claim status onto the same stage as its queued status', () => {
    expect(statesOf('EXTRACTING_DATA')).toEqual(statesOf('TEXT_READY'));
  });

  it('advances the active stage as the pipeline moves', () => {
    const uploaded = resolvePipeline({ status: 'UPLOADED' });
    expect(uploaded.stages[0]?.state).toBe('active');
    expect(uploaded.currentStep).toBe(1);
    expect(uploaded.stages[1]?.state).toBe('pending');
    expect(statesOf('TEXT_READY')[2]).toBe('active');
    expect(statesOf('VALIDATING')[3]).toBe('active');
    expect(statesOf('GENERATING_DOCUMENT')[4]).toBe('active');
  });

  it('stops a validation-caused NEEDS_REVIEW at the checking stage', () => {
    const pipeline = resolvePipeline({
      status: 'NEEDS_REVIEW',
      findings: [finding({ rule: 'arithmetic.gross' })],
    });

    expect(pipeline.stages[3]?.state).toBe('stopped');
    expect(pipeline.stages[4]?.state).toBe('pending');
    expect(pipeline.outcome).toBe('needs_review');
  });

  it('stops a mapping-caused NEEDS_REVIEW one stage later', () => {
    const pipeline = resolvePipeline({
      status: 'NEEDS_REVIEW',
      findings: [
        finding({ rule: 'mapping.line_unit', field: 'lineItems[0].unit' }),
      ],
    });

    expect(pipeline.stages[3]?.state).toBe('done');
    expect(pipeline.stages[4]?.state).toBe('stopped');
    expect(pipeline.outcome).toBe('needs_review_mapping');
  });

  it('ignores a passed mapping finding when placing the stop', () => {
    const pipeline = resolvePipeline({
      status: 'NEEDS_REVIEW',
      findings: [
        finding({ rule: 'mapping.currency', passed: true }),
        finding({ rule: 'arithmetic.gross' }),
      ],
    });

    expect(pipeline.outcome).toBe('needs_review');
  });

  it('places a failure on the stage its dead letter names', () => {
    const pipeline = resolvePipeline({
      status: 'FAILED',
      deadLetter: { stage: 'generation', failedAt: '2026-08-14T10:00:00.000Z' },
    });

    expect(pipeline.stages[4]?.state).toBe('failed');
    expect(pipeline.stages[3]?.state).toBe('done');
  });

  it('falls back to the first processing stage when neither a dead letter nor a failure code is known', () => {
    const pipeline = resolvePipeline({ status: 'FAILED' });

    expect(pipeline.stages[1]?.state).toBe('failed');
    expect(pipeline.outcome).toBe('failed');
  });

  it('places a fail-fast text-extraction failure at the text stage', () => {
    const pipeline = resolvePipeline({
      status: 'FAILED',
      failure: { code: 'pdf_unreadable' },
    });

    expect(pipeline.stages[1]?.state).toBe('failed');
  });

  it('places a fail-fast data-extraction failure at the data stage, not text', () => {
    const pipeline = resolvePipeline({
      status: 'FAILED',
      failure: { code: 'llm_provider_error' },
    });

    expect(pipeline.stages[1]?.state).toBe('done');
    expect(pipeline.stages[2]?.state).toBe('failed');
  });

  it('prefers the dead letter over the failure code when both are present', () => {
    const pipeline = resolvePipeline({
      status: 'FAILED',
      failure: { code: 'llm_provider_error' },
      deadLetter: { stage: 'validation', failedAt: '2026-08-14T10:00:00.000Z' },
    });

    expect(pipeline.stages[3]?.state).toBe('failed');
  });

  it('stops a KoSIT-rejection-caused NEEDS_REVIEW at the generation stage, not checking', () => {
    const pipeline = resolvePipeline({
      status: 'NEEDS_REVIEW',
      findings: [finding({ rule: 'kosit.BR-DE-15', field: null })],
    });

    expect(pipeline.stages[3]?.state).toBe('done');
    expect(pipeline.stages[4]?.state).toBe('stopped');
    expect(pipeline.outcome).toBe('needs_review_mapping');
  });

  it('reports what each completed stage established', () => {
    const pipeline = resolvePipeline({
      status: 'READY',
      pageCount: 2,
      sourceType: 'NATIVE',
      lineItemCount: 7,
      findings: [finding({ passed: true }), finding({ passed: true })],
    });

    expect(pipeline.stages[1]?.fact).toEqual({
      kind: 'pages',
      pageCount: 2,
      sourceType: 'NATIVE',
    });
    expect(pipeline.stages[2]?.fact).toEqual({ kind: 'lineItems', count: 7 });
    expect(pipeline.stages[3]?.fact).toEqual({
      kind: 'checks',
      passed: 2,
      failed: 0,
    });
    expect(pipeline.stages[4]?.fact).toEqual({ kind: 'kositAccepted' });
  });

  it('omits a fact the payload cannot support yet', () => {
    const pipeline = resolvePipeline({ status: 'EXTRACTING_TEXT' });

    expect(pipeline.stages.every((stage) => stage.fact === null)).toBe(true);
  });
});
