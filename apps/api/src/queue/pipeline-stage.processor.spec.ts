import { InvoiceStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import type { InvoiceStateMachine } from './invoice-state-machine';
import { PipelineStage } from './pipeline-stage';
import {
  type ClaimableInvoice,
  PipelineStageProcessor,
} from './pipeline-stage.processor';
import type {
  FailedStageJob,
  LifecycleJobData,
  PipelineStageQueue,
  PipelineStageQueueConfig,
} from './pipeline-stage-queue';

const JOB_DATA: LifecycleJobData = {
  invoiceId: 'invoice-1',
  storageKey: 'storage-key-1',
};

const RETRY_EXHAUSTED_FAILURE = {
  code: 'validation_retries_exhausted',
} as const;

const CONFIG: PipelineStageQueueConfig = {
  stage: PipelineStage.VALIDATION,
  claimFrom: InvoiceStatus.DATA_READY,
  claimTo: InvoiceStatus.VALIDATING,
  retryExhaustedFailure: RETRY_EXHAUSTED_FAILURE,
  reopenTo: InvoiceStatus.VALIDATING,
};

function failedEventJob(finishedOn: number | undefined) {
  return {
    name: 'extract',
    data: JOB_DATA,
    failedReason: 'boom',
    attemptsMade: 1,
    finishedOn,
  };
}

class TestProcessor extends PipelineStageProcessor {
  protected readonly stateMachine = {} as unknown as InvoiceStateMachine;

  constructor(
    protected readonly stageQueue: PipelineStageQueue,
    protected readonly stageLogger: PinoLogger,
  ) {
    super();
  }

  protected async processInvoice(): Promise<void> {}

  acceptJob<Invoice extends ClaimableInvoice>(
    job: FailedStageJob,
    invoice: Invoice | null,
  ): Promise<Invoice | null> {
    return this.acceptStageJob(job, invoice);
  }
}

describe('PipelineStageProcessor', () => {
  let stageQueue: {
    finalizeFailure: jest.Mock;
    config: PipelineStageQueueConfig;
  };
  let stageLogger: { info: jest.Mock };
  let processor: TestProcessor;

  beforeEach(() => {
    stageQueue = {
      finalizeFailure: jest.fn().mockResolvedValue(undefined),
      config: CONFIG,
    };
    stageLogger = { info: jest.fn() };
    processor = new TestProcessor(
      stageQueue as unknown as PipelineStageQueue,
      stageLogger as unknown as PinoLogger,
    );
  });

  it('finalizes a job BullMQ has given up on', async () => {
    const job = failedEventJob(Date.now());
    const error = new Error('job stalled more than allowable limit');

    await processor.onFailed(job as unknown as Job<LifecycleJobData>, error);

    expect(stageQueue.finalizeFailure).toHaveBeenCalledWith(job, error);
  });

  it('leaves a job BullMQ will retry alone', async () => {
    const job = failedEventJob(undefined);

    await processor.onFailed(
      job as unknown as Job<LifecycleJobData>,
      new Error('transient'),
    );

    expect(stageQueue.finalizeFailure).not.toHaveBeenCalled();
  });

  it('does nothing when BullMQ reports a failure with no job attached', async () => {
    await processor.onFailed(undefined, new Error('boom'));

    expect(stageQueue.finalizeFailure).not.toHaveBeenCalled();
    expect(stageLogger.info).not.toHaveBeenCalled();
  });

  it('reports an attempt BullMQ will retry as a failed stage event', async () => {
    const job = failedEventJob(undefined);

    await processor.onFailed(
      job as unknown as Job<LifecycleJobData>,
      new Error('transient'),
    );

    expect(stageLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: JOB_DATA.invoiceId,
        stage: PipelineStage.VALIDATION,
        outcome: 'failed',
        attempt: 1,
      }),
      'Pipeline stage finished',
    );
  });
});

describe('PipelineStageProcessor.acceptStageJob', () => {
  let stageQueue: { moveToDlq: jest.Mock; config: PipelineStageQueueConfig };
  let processor: TestProcessor;

  beforeEach(() => {
    stageQueue = {
      moveToDlq: jest.fn().mockResolvedValue(undefined),
      config: CONFIG,
    };
    processor = new TestProcessor(
      stageQueue as unknown as PipelineStageQueue,
      { info: jest.fn() } as unknown as PinoLogger,
    );
  });

  function job(): FailedStageJob {
    return {
      name: 'validate',
      data: JOB_DATA,
      failedReason: 'disk unavailable',
      attemptsMade: 0,
    };
  }

  function claimableInvoice(
    overrides: Partial<ClaimableInvoice> = {},
  ): ClaimableInvoice {
    return {
      id: 'invoice-1',
      storageKey: JOB_DATA.storageKey,
      status: InvoiceStatus.FAILED,
      failureCode: RETRY_EXHAUSTED_FAILURE.code,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    };
  }

  it('dead-letters a retained failure whose lifecycle is still current', async () => {
    const currentJob = job();

    await expect(
      processor.acceptJob(currentJob, claimableInvoice()),
    ).resolves.toBeNull();

    expect(stageQueue.moveToDlq).toHaveBeenCalledWith(
      currentJob,
      'disk unavailable',
    );
  });

  it('does not dead-letter a matching failure whose lifecycle already expired', async () => {
    const invoice = claimableInvoice({ expiresAt: new Date(Date.now() - 1) });

    await expect(processor.acceptJob(job(), invoice)).resolves.toBeNull();

    expect(stageQueue.moveToDlq).not.toHaveBeenCalled();
  });

  it('does not dead-letter when the invoice was already deleted', async () => {
    await expect(processor.acceptJob(job(), null)).resolves.toBeNull();

    expect(stageQueue.moveToDlq).not.toHaveBeenCalled();
  });

  it('does not dead-letter a matching failure from an earlier storage lifecycle', async () => {
    const invoice = claimableInvoice({ storageKey: 'old-storage-key' });

    await expect(processor.acceptJob(job(), invoice)).resolves.toBeNull();

    expect(stageQueue.moveToDlq).not.toHaveBeenCalled();
  });

  it('claims a job whose invoice sits in claimFrom or claimTo', async () => {
    const invoice = claimableInvoice({ status: InvoiceStatus.DATA_READY });

    await expect(processor.acceptJob(job(), invoice)).resolves.toBe(invoice);
  });
});
