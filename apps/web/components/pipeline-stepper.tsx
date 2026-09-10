'use client';

import type { ReactNode } from 'react';
import { useDictionary } from '@/lib/i18n/dictionary-context';
import {
  stageIds,
  type PipelineView,
  type Stage,
  type StageFact,
  type StageId,
  type StageState,
} from '@/lib/pipeline/stages';
import type { Dictionary } from '@/lib/i18n/dictionary';
import type { PipelineStage } from '@/lib/api/schemas';

const markers: Record<StageState, string> = {
  done: '✓',
  active: '◐',
  pending: '○',
  stopped: '!',
  failed: '✕',
};

const markerClasses: Record<StageState, string> = {
  done: 'text-ok',
  active: 'text-text',
  pending: 'text-text-muted',
  stopped: 'text-warning',
  failed: 'text-error',
};

const barClasses: Record<StageState, string> = {
  done: 'bg-ok',
  active: 'bg-text animate-pulse',
  pending: 'bg-border',
  stopped: 'bg-warning',
  failed: 'bg-error',
};

const outcomeKeys = {
  running: 'running',
  needs_review: 'needsReview',
  needs_review_mapping: 'needsReviewMapping',
  ready: 'ready',
  failed: 'failed',
} as const;

function describeFact(fact: StageFact, dictionary: Dictionary): string {
  switch (fact.kind) {
    case 'pages':
      return dictionary.pipeline.fact.pages(
        fact.pageCount,
        dictionary.sourceType[fact.sourceType],
      );
    case 'lineItems':
      return dictionary.pipeline.fact.lineItems(fact.count);
    case 'checks':
      return dictionary.pipeline.fact.checks(fact.passed, fact.failed);
    case 'kositAccepted':
      return dictionary.pipeline.fact.kositAccepted;
  }
}

const pipelineStageByStageId: Partial<Record<StageId, PipelineStage>> = {
  text: 'text-extraction',
  data: 'data-extraction',
  checked: 'validation',
  generated: 'generation',
};

function stageLabel(stage: Stage, dictionary: Dictionary): string {
  const labels = dictionary.pipeline.stage[stage.id];
  if (stage.state === 'active') return labels.active;
  if (stage.state === 'done' || stage.state === 'stopped') return labels.done;

  const pipelineStage = pipelineStageByStageId[stage.id];
  return pipelineStage ? dictionary.pipelineStage[pipelineStage] : labels.done;
}

export function PipelineStepper({ pipeline }: { pipeline: PipelineView }) {
  const dictionary = useDictionary();

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <p className="mb-3 text-sm text-text-muted">
        {dictionary.pipeline.stepOf(pipeline.currentStep, stageIds.length)}
      </p>
      <ol className="flex flex-col gap-2">
        {pipeline.stages.map((stage) => (
          <li key={stage.id} className="flex items-baseline gap-3 text-sm">
            <span
              aria-hidden="true"
              className={`w-4 shrink-0 text-center ${markerClasses[stage.state]}`}
            >
              {markers[stage.state]}
            </span>
            <span
              className={
                stage.state === 'pending' ? 'text-text-muted' : 'text-text'
              }
            >
              {stageLabel(stage, dictionary)}
              <span className="sr-only">
                {` — ${dictionary.pipeline.stageState[stage.state]}`}
              </span>
            </span>
            {stage.fact && (
              <span className="text-text-muted">
                · {describeFact(stage.fact, dictionary)}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-text">
        {dictionary.pipeline.outcome[outcomeKeys[pipeline.outcome]]}
      </p>
    </div>
  );
}

export function CompactPipeline({
  pipeline,
  trailing,
}: {
  pipeline: PipelineView;
  trailing: ReactNode;
}) {
  const dictionary = useDictionary();
  const current =
    pipeline.stages.find(
      (stage) => stage.state !== 'done' && stage.state !== 'pending',
    ) ?? pipeline.stages[pipeline.stages.length - 1];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1" aria-hidden="true">
        {pipeline.stages.map((stage) => (
          <span
            key={stage.id}
            className={`h-1.5 w-6 rounded-full ${barClasses[stage.state]}`}
          />
        ))}
      </div>
      <span className="flex items-center text-xs text-text-muted">
        <span>
          {current ? stageLabel(current, dictionary) : ''}
          {' · '}
          {dictionary.pipeline.stepOf(pipeline.currentStep, stageIds.length)}
        </span>
        {trailing}
      </span>
    </div>
  );
}
