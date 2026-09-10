import { Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import {
  RawExtractedInvoiceDataSchema,
  type InvoiceFailure,
} from '@pdf-to-xrechnung/contracts';
import { isEmptyExtraction } from './empty-extraction';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import { PipelineStageProcessor } from '../queue/pipeline-stage.processor';
import {
  publishNextStage,
  type FailedStageJob,
} from '../queue/pipeline-stage-queue';
import { DataExtractionQueue } from './data-extraction-queue.service';
import {
  ExtractionAttemptRunner,
  type ExtractionAttemptOutcome,
} from './extraction-attempt.runner';
import {
  LLM_PROVIDER,
  NonRetryableLlmProviderError,
  RetryableLlmProviderError,
} from './llm-provider.interface';
import type { LlmProvider } from './llm-provider.interface';
import { PROMPT_VERSION } from './prompt';
import { ValidationQueue } from '../validation/validation-queue.service';

const EMPTY_RESULT_FAILURE = {
  code: 'llm_no_usable_data',
} satisfies InvoiceFailure;

@Processor(PipelineStage.DATA_EXTRACTION)
export class DataExtractionProcessor extends PipelineStageProcessor {
  constructor(
    private readonly prisma: PrismaService,
    protected readonly stateMachine: InvoiceStateMachine,
    protected readonly stageQueue: DataExtractionQueue,
    private readonly validationQueue: ValidationQueue,
    private readonly runner: ExtractionAttemptRunner,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    protected readonly stageLogger: PinoLogger,
  ) {
    super();
    this.stageLogger.setContext(DataExtractionProcessor.name);
  }

  protected async processInvoice(job: FailedStageJob): Promise<void> {
    const loaded = await this.prisma.invoice.findUnique({
      where: { id: job.data.invoiceId },
    });

    const invoice = await this.acceptStageJob(job, loaded);
    if (!invoice || !(await this.claimStage(invoice, job))) {
      return;
    }

    if (!invoice.extractedText) {
      await this.failAsEmpty(job, invoice.id, invoice.storageKey);
      return;
    }

    const reusableAttempt = await this.prisma.extractionAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        provider: this.provider.name,
        model: this.provider.model,
        promptVersion: PROMPT_VERSION,
        parsedData: { not: Prisma.DbNull },
      },
      orderBy: { attemptNumber: 'desc' },
    });

    if (reusableAttempt) {
      const revalidated = RawExtractedInvoiceDataSchema.safeParse(
        reusableAttempt.parsedData,
      );
      if (revalidated.success) {
        if (isEmptyExtraction(revalidated.data)) {
          await this.failAsEmpty(job, invoice.id, invoice.storageKey);
          return;
        }
        await this.markDataReady(job, invoice.id, invoice.storageKey);
        return;
      }
    }

    let outcome: ExtractionAttemptOutcome;
    try {
      outcome = await this.runner.run({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        invoiceText: invoice.extractedText,
      });
    } catch (error) {
      if (error instanceof RetryableLlmProviderError) {
        throw error;
      }
      if (!(error instanceof NonRetryableLlmProviderError)) {
        throw error;
      }
      this.stageLogger.error(
        { err: error, invoiceId: invoice.id },
        'Data extraction failed',
      );
      const transitionOutcome = await this.stateMachine.transition({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        from: InvoiceStatus.EXTRACTING_DATA,
        to: InvoiceStatus.FAILED,
        data: {
          failure: { code: 'llm_provider_error' },
        },
      });
      if (transitionOutcome === 'lost') {
        this.emitStageEvent(job, 'lost-claim');
        return;
      }
      this.emitStageEvent(job, 'failed');
      return;
    }

    if (outcome.status === 'stale') {
      this.emitStageEvent(job, 'skipped-stale');
      return;
    }

    if (outcome.status === 'failed') {
      const failureCode =
        outcome.failureKind === 'json'
          ? 'llm_response_not_json'
          : outcome.failureKind === 'truncated'
            ? 'llm_response_truncated'
            : 'llm_response_schema_mismatch';
      const transitionOutcome = await this.stateMachine.transition({
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
        from: InvoiceStatus.EXTRACTING_DATA,
        to: InvoiceStatus.FAILED,
        data: { failure: { code: failureCode } },
      });
      if (transitionOutcome === 'lost') {
        this.emitStageEvent(job, 'lost-claim');
        return;
      }
      this.emitStageEvent(job, 'failed');
      return;
    }

    if (isEmptyExtraction(outcome.data)) {
      await this.failAsEmpty(job, invoice.id, invoice.storageKey);
      return;
    }

    await this.markDataReady(job, invoice.id, invoice.storageKey);
  }

  private async markDataReady(
    job: FailedStageJob,
    invoiceId: string,
    storageKey: string,
  ): Promise<void> {
    const transitionOutcome = await this.stateMachine.transition({
      invoiceId,
      storageKey,
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.DATA_READY,
    });
    if (transitionOutcome === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }
    await publishNextStage({
      stateMachine: this.stateMachine,
      ownQueue: this.stageQueue,
      nextQueue: this.validationQueue,
      invoiceId,
      storageKey,
    });
    this.emitStageEvent(job, 'completed');
  }

  private async failAsEmpty(
    job: FailedStageJob,
    invoiceId: string,
    storageKey: string,
  ): Promise<void> {
    const transitionOutcome = await this.stateMachine.transition({
      invoiceId,
      storageKey,
      from: InvoiceStatus.EXTRACTING_DATA,
      to: InvoiceStatus.FAILED,
      data: { failure: EMPTY_RESULT_FAILURE },
    });
    if (transitionOutcome === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }
    this.emitStageEvent(job, 'failed');
  }
}
