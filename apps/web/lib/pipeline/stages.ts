import type {
  InvoiceDeadLetter,
  InvoiceFailure,
  InvoiceFinding,
  InvoiceStatus,
  PipelineStage,
  SourceType,
} from '@/lib/api/schemas';

export const stageIds = [
  'uploaded',
  'text',
  'data',
  'checked',
  'generated',
] as const;
export type StageId = (typeof stageIds)[number];

export type StageState = 'done' | 'active' | 'pending' | 'stopped' | 'failed';

export type StageFact =
  | { kind: 'pages'; pageCount: number; sourceType: SourceType }
  | { kind: 'lineItems'; count: number }
  | { kind: 'checks'; passed: number; failed: number }
  | { kind: 'kositAccepted' };

export interface Stage {
  id: StageId;
  state: StageState;
  fact: StageFact | null;
}

type PipelineOutcome =
  'running' | 'needs_review' | 'needs_review_mapping' | 'ready' | 'failed';

export interface PipelineView {
  stages: Stage[];
  outcome: PipelineOutcome;
  currentStep: number;
}

const activeIndexByStatus: Record<InvoiceStatus, number> = {
  UPLOADED: 0,
  EXTRACTING_TEXT: 1,
  TEXT_READY: 2,
  EXTRACTING_DATA: 2,
  DATA_READY: 3,
  VALIDATING: 3,
  NEEDS_REVIEW: 3,
  GENERATING: 4,
  GENERATING_DOCUMENT: 4,
  READY: stageIds.length,
  FAILED: 0,
};

const indexByDeadLetterStage: Record<PipelineStage, number> = {
  'text-extraction': 1,
  'data-extraction': 2,
  validation: 3,
  generation: 4,
};

const stageIndexByFailureCode: Record<InvoiceFailure['code'], number> = {
  pdf_unreadable: 1,
  pdf_no_pages: 1,
  pdf_too_many_pages: 1,
  pdf_resource_limit: 1,
  ocr_text_too_sparse: 1,
  ocr_confidence_too_low: 1,
  text_too_long: 1,
  text_extraction_retries_exhausted: 1,
  llm_provider_error: 2,
  llm_response_not_json: 2,
  llm_response_schema_mismatch: 2,
  llm_response_truncated: 2,
  llm_no_usable_data: 2,
  data_extraction_retries_exhausted: 2,
  validation_retries_exhausted: 3,
  generation_retries_exhausted: 4,
};

function stopsAtGenerationStage(findings: InvoiceFinding[]): boolean {
  return findings.some(
    (finding) =>
      !finding.passed &&
      (finding.rule.startsWith('mapping.') ||
        finding.rule.startsWith('kosit.')),
  );
}

export interface PipelineInput {
  status: InvoiceStatus;
  findings?: InvoiceFinding[];
  deadLetter?: InvoiceDeadLetter | null;
  failure?: InvoiceFailure | null;
  pageCount?: number | null;
  sourceType?: SourceType;
  lineItemCount?: number | null;
}

export function resolvePipeline({
  status,
  findings = [],
  deadLetter = null,
  failure = null,
  pageCount = null,
  sourceType,
  lineItemCount = null,
}: PipelineInput): PipelineView {
  const generationStop =
    status === 'NEEDS_REVIEW' && stopsAtGenerationStage(findings);

  const stoppedIndex = generationStop ? 4 : activeIndexByStatus[status];
  const failedIndex =
    status === 'FAILED' ? failedStageIndex({ deadLetter, failure }) : -1;
  const activeIndex = status === 'FAILED' ? failedIndex : stoppedIndex;

  const facts: Record<StageId, StageFact | null> = {
    uploaded: null,
    text:
      pageCount === null
        ? null
        : { kind: 'pages', pageCount, sourceType: sourceType ?? 'UNKNOWN' },
    data:
      lineItemCount === null
        ? null
        : { kind: 'lineItems', count: lineItemCount },
    checked: checksFact(findings),
    generated: status === 'READY' ? { kind: 'kositAccepted' } : null,
  };

  const stages = stageIds.map((id, index): Stage => {
    const fact = facts[id];

    if (status === 'FAILED') {
      if (index < failedIndex) return { id, state: 'done', fact };
      if (index === failedIndex) return { id, state: 'failed', fact: null };
      return { id, state: 'pending', fact: null };
    }

    if (index < activeIndex) return { id, state: 'done', fact };
    if (index > activeIndex) return { id, state: 'pending', fact: null };
    return {
      id,
      state: status === 'NEEDS_REVIEW' ? 'stopped' : 'active',
      fact: status === 'NEEDS_REVIEW' ? fact : null,
    };
  });

  return {
    stages,
    outcome: outcomeFor(status, generationStop),
    currentStep: Math.min(Math.max(activeIndex + 1, 1), stageIds.length),
  };
}

function failedStageIndex({
  deadLetter,
  failure,
}: {
  deadLetter: InvoiceDeadLetter | null;
  failure: InvoiceFailure | null;
}): number {
  if (deadLetter) return indexByDeadLetterStage[deadLetter.stage];
  if (failure) return stageIndexByFailureCode[failure.code];
  return 1;
}

function outcomeFor(
  status: InvoiceStatus,
  generationStop: boolean,
): PipelineOutcome {
  if (status === 'READY') return 'ready';
  if (status === 'FAILED') return 'failed';
  if (status === 'NEEDS_REVIEW')
    return generationStop ? 'needs_review_mapping' : 'needs_review';
  return 'running';
}

function checksFact(findings: InvoiceFinding[]): StageFact | null {
  if (findings.length === 0) return null;
  const failed = findings.filter((finding) => !finding.passed).length;
  return { kind: 'checks', passed: findings.length - failed, failed };
}
