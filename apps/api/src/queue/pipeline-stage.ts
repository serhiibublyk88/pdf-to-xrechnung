export enum PipelineStage {
  TEXT_EXTRACTION = 'text-extraction',
  DATA_EXTRACTION = 'data-extraction',
  VALIDATION = 'validation',
  GENERATION = 'generation',
}

export function dlqQueueName(stage: PipelineStage): string {
  return `${stage}-dlq`;
}

function jobIdFor(stage: PipelineStage, invoiceId: string): string {
  return `${stage}-${invoiceId}`;
}

export function lifecycleJobIdFor(
  stage: PipelineStage,
  invoiceId: string,
  storageKey: string,
): string {
  return `${jobIdFor(stage, invoiceId)}-${storageKey}`;
}
