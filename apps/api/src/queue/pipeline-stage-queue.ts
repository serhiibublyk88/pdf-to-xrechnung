import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';
import { InvoiceStatus } from '@prisma/client';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from './invoice-state-machine';
import { lifecycleJobIdFor, PipelineStage } from './pipeline-stage';
import { logStageEvent, type StageOutcome } from './stage-event';

export interface LifecycleJobData {
  invoiceId: string;
  storageKey: string;
}

export interface DeadLetterJobData extends LifecycleJobData {
  failedAt: string;
  failureReason: string | null;
}

export type FailedStageJob = Pick<
  Job<LifecycleJobData>,
  'data' | 'failedReason' | 'name' | 'attemptsMade' | 'processedOn'
>;

export class DeadLetterRetryUnavailableError extends Error {}

const BATCH_SIZE = 100;

export interface PipelineStageQueueConfig {
  stage: PipelineStage;
  claimFrom: InvoiceStatus;
  claimTo: InvoiceStatus;
  retryExhaustedFailure: InvoiceFailure;
  reopenTo: InvoiceStatus;
}

export abstract class PipelineStageQueue {
  private readonly jobOptions: JobsOptions;

  protected constructor(
    private readonly queue: Queue<LifecycleJobData>,
    private readonly dlq: Queue<DeadLetterJobData>,
    private readonly stateMachine: InvoiceStateMachine,
    private readonly prisma: PrismaService,
    readonly config: PipelineStageQueueConfig,
    retentionHours: number,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(this.constructor.name);
    this.jobOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { age: retentionHours * 60 * 60 },
    };
  }

  get inFlightStatuses(): InvoiceStatus[] {
    return [this.config.claimFrom, this.config.claimTo];
  }

  enqueue(jobData: LifecycleJobData): Promise<Job<LifecycleJobData>> {
    return this.queue.add(this.config.stage, jobData, {
      ...this.jobOptions,
      jobId: this.jobIdFor(jobData),
    });
  }

  async requeueStranded(jobData: LifecycleJobData): Promise<boolean> {
    const job = await this.enqueue(jobData);
    const state = await job.getState();
    return state !== 'completed' && state !== 'failed' && state !== 'unknown';
  }

  moveToDlq(
    job: FailedStageJob,
    failureReason = job.failedReason ?? null,
  ): Promise<Job<DeadLetterJobData>> {
    return this.dlq.add(
      job.name,
      { ...job.data, failedAt: new Date().toISOString(), failureReason },
      { jobId: this.jobIdFor(job.data) },
    );
  }

  async finalizeFailure(job: FailedStageJob, error: unknown): Promise<void> {
    try {
      const belongsToCurrentLifecycle =
        await this.stateMachine.failIrrecoverably({
          invoiceId: job.data.invoiceId,
          storageKey: job.data.storageKey,
          from: this.inFlightStatuses,
          failure: this.config.retryExhaustedFailure,
        });
      if (belongsToCurrentLifecycle === 'claimed') {
        await this.moveToDlq(
          job,
          error instanceof Error ? error.message : String(error),
        );
      }
      this.emitStageEvent(
        job,
        belongsToCurrentLifecycle === 'claimed'
          ? 'dead-letter'
          : 'skipped-stale',
      );
    } catch (finalizationError) {
      this.logger.error(
        {
          err: finalizationError,
          invoiceId: job.data.invoiceId,
          stage: this.config.stage,
        },
        'Could not finalize exhausted stage; startup reconciliation will retry',
      );
    }
  }

  async reconcileFailedJobs(): Promise<number> {
    let reconciled = 0;
    let start = 0;

    for (;;) {
      const failedJobs = await this.queue.getJobs(
        'failed',
        start,
        start + BATCH_SIZE - 1,
      );
      if (failedJobs.length === 0) {
        break;
      }

      for (const job of failedJobs) {
        const belongsToCurrentLifecycle =
          await this.stateMachine.failIrrecoverably({
            invoiceId: job.data.invoiceId,
            storageKey: job.data.storageKey,
            from: this.inFlightStatuses,
            failure: this.config.retryExhaustedFailure,
          });
        if (belongsToCurrentLifecycle === 'claimed') {
          await this.moveToDlq(job);
          this.emitStageEvent(job, 'dead-letter');
          reconciled++;
        }
      }

      if (failedJobs.length < BATCH_SIZE) {
        break;
      }
      start += BATCH_SIZE;
    }

    return reconciled;
  }

  async retryFromDlq(invoiceId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { storageKey: true },
    });
    if (!invoice) {
      throw new DeadLetterRetryUnavailableError(
        `Invoice ${invoiceId} does not exist`,
      );
    }

    const jobId = lifecycleJobIdFor(
      this.config.stage,
      invoiceId,
      invoice.storageKey,
    );
    const dlqJob = await this.dlq.getJob(jobId);
    if (!dlqJob) {
      throw new DeadLetterRetryUnavailableError(
        `No dead-lettered ${this.config.stage} job for invoice ${invoiceId}`,
      );
    }
    const storageKey = dlqJob.data.storageKey;

    // Before reopening: a crash after it leaves this job re-failing the new lifecycle.
    const retainedPrimary = await this.queue.getJob(jobId);
    if (retainedPrimary && (await retainedPrimary.getState()) === 'failed') {
      await retainedPrimary.remove();
    }

    const belongsToCurrentLifecycle =
      await this.stateMachine.reopenAfterDeadLetter({
        invoiceId,
        storageKey,
        to: this.config.reopenTo,
      });
    if (belongsToCurrentLifecycle === 'lost') {
      await dlqJob.remove();
      throw new DeadLetterRetryUnavailableError(
        `Dead-lettered ${this.config.stage} job for invoice ${invoiceId} belongs to an expired lifecycle`,
      );
    }

    const publishedPrimary = await this.queue.getJob(jobId);
    if (publishedPrimary && (await publishedPrimary.getState()) !== 'failed') {
      await dlqJob.remove();
      return;
    }

    await publishedPrimary?.remove();
    const jobData: LifecycleJobData = { invoiceId, storageKey };
    await this.queue.add(dlqJob.name, jobData, {
      ...this.jobOptions,
      jobId,
    });
    await dlqJob.remove();
  }

  async getDeadLetter(
    invoiceId: string,
    storageKey: string,
  ): Promise<DeadLetterJobData | null> {
    const job = await this.dlq.getJob(this.jobIdFor({ invoiceId, storageKey }));
    return job?.data ?? null;
  }

  async removeDeadLetter(invoiceId: string, storageKey: string): Promise<void> {
    const job = await this.dlq.getJob(this.jobIdFor({ invoiceId, storageKey }));
    await job?.remove();
  }

  private jobIdFor({ invoiceId, storageKey }: LifecycleJobData): string {
    return lifecycleJobIdFor(this.config.stage, invoiceId, storageKey);
  }

  private emitStageEvent(job: FailedStageJob, outcome: StageOutcome): void {
    logStageEvent({
      logger: this.logger,
      job,
      stage: this.config.stage,
      outcome,
    });
  }
}

export async function publishNextStage({
  stateMachine,
  ownQueue,
  nextQueue,
  invoiceId,
  storageKey,
}: {
  stateMachine: InvoiceStateMachine;
  ownQueue: PipelineStageQueue;
  nextQueue: PipelineStageQueue;
  invoiceId: string;
  storageKey: string;
}): Promise<void> {
  try {
    await nextQueue.enqueue({ invoiceId, storageKey });
  } catch (enqueueError) {
    const rollback = await stateMachine.transition({
      invoiceId,
      storageKey,
      from: nextQueue.config.claimFrom,
      to: ownQueue.config.claimTo,
    });
    if (rollback === 'lost') {
      return;
    }
    throw enqueueError;
  }
}
