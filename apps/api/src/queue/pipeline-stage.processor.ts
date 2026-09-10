import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { InvoiceStateMachine } from './invoice-state-machine';
import type {
  FailedStageJob,
  LifecycleJobData,
  PipelineStageQueue,
} from './pipeline-stage-queue';
import { logStageEvent, type StageOutcome } from './stage-event';

export interface ClaimableInvoice {
  id: string;
  storageKey: string;
  status: InvoiceStatus;
  failureCode: string | null;
  expiresAt: Date;
}

export abstract class PipelineStageProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  protected abstract readonly stageQueue: PipelineStageQueue;
  protected abstract readonly stateMachine: InvoiceStateMachine;
  protected abstract readonly stageLogger: PinoLogger;

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  async process(job: FailedStageJob): Promise<void> {
    await this.processInvoice(job);
  }

  // finishedOn is set only once BullMQ gives up, even for a stalled job with attemptsMade at 1.
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<LifecycleJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    this.emitStageEvent(job, 'failed');
    if (!job.finishedOn) {
      return;
    }
    await this.stageQueue.finalizeFailure(job, error);
  }

  protected emitStageEvent(job: FailedStageJob, outcome: StageOutcome): void {
    logStageEvent({
      logger: this.stageLogger,
      job,
      stage: this.stageQueue.config.stage,
      outcome,
    });
  }

  protected async acceptStageJob<Invoice extends ClaimableInvoice>(
    job: FailedStageJob,
    invoice: Invoice | null,
  ): Promise<Invoice | null> {
    const { claimFrom, claimTo, retryExhaustedFailure } =
      this.stageQueue.config;

    if (
      !invoice ||
      invoice.storageKey !== job.data.storageKey ||
      invoice.expiresAt <= new Date()
    ) {
      this.emitStageEvent(job, 'skipped-stale');
      return null;
    }

    if (
      invoice.status === InvoiceStatus.FAILED &&
      invoice.failureCode === retryExhaustedFailure.code
    ) {
      await this.stageQueue.moveToDlq(
        job,
        job.failedReason ?? retryExhaustedFailure.code,
      );
      this.emitStageEvent(job, 'dead-letter');
      return null;
    }

    if (invoice.status !== claimFrom && invoice.status !== claimTo) {
      this.emitStageEvent(job, 'skipped-stale');
      return null;
    }

    return invoice;
  }

  protected async claimStage(
    invoice: ClaimableInvoice,
    job: FailedStageJob,
  ): Promise<boolean> {
    const { claimFrom, claimTo } = this.stageQueue.config;
    if (invoice.status === claimTo) {
      return true;
    }

    const outcome = await this.stateMachine.transition({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      from: claimFrom,
      to: claimTo,
    });
    if (outcome === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return false;
    }
    return true;
  }

  protected abstract processInvoice(job: FailedStageJob): Promise<void>;
}
