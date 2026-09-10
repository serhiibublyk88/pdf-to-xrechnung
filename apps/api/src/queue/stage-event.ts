import type { PinoLogger } from 'nestjs-pino';
import type { PipelineStage } from './pipeline-stage';
import type { FailedStageJob } from './pipeline-stage-queue';

export type StageOutcome =
  'completed' | 'skipped-stale' | 'lost-claim' | 'failed' | 'dead-letter';

export function logStageEvent({
  logger,
  job,
  stage,
  outcome,
}: {
  logger: PinoLogger;
  job: FailedStageJob;
  stage: PipelineStage;
  outcome: StageOutcome;
}): void {
  logger.info(
    {
      invoiceId: job.data.invoiceId,
      stage,
      outcome,
      durationMs: job.processedOn ? Date.now() - job.processedOn : null,
      attempt: job.attemptsMade,
    },
    'Pipeline stage finished',
  );
}
