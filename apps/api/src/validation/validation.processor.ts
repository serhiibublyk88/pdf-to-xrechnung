import { Processor } from '@nestjs/bullmq';
import { InvoiceStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { latestParsedExtractionAttempt } from '../data-extraction/latest-extraction-attempt';
import { GenerationQueue } from '../generation/generation-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import { PipelineStageProcessor } from '../queue/pipeline-stage.processor';
import {
  publishNextStage,
  type FailedStageJob,
} from '../queue/pipeline-stage-queue';
import {
  reviewRoutingStatus,
  validateExtractedInvoice,
} from './invoice-validator';
import { ValidationQueue } from './validation-queue.service';

@Processor(PipelineStage.VALIDATION)
export class ValidationProcessor extends PipelineStageProcessor {
  constructor(
    private readonly prisma: PrismaService,
    protected readonly stateMachine: InvoiceStateMachine,
    protected readonly stageQueue: ValidationQueue,
    private readonly generationQueue: GenerationQueue,
    protected readonly stageLogger: PinoLogger,
  ) {
    super();
    this.stageLogger.setContext(ValidationProcessor.name);
  }

  protected async processInvoice(job: FailedStageJob): Promise<void> {
    const loaded = await this.prisma.invoice.findUnique({
      where: { id: job.data.invoiceId },
      select: {
        id: true,
        storageKey: true,
        status: true,
        failureCode: true,
        expiresAt: true,
      },
    });

    const invoice = await this.acceptStageJob(job, loaded);
    if (!invoice || !(await this.claimStage(invoice, job))) {
      return;
    }

    const parsedData = await latestParsedExtractionAttempt(
      this.prisma,
      invoice.id,
      invoice.storageKey,
    );
    const validationResults = validateExtractedInvoice(parsedData, new Date());
    const to = reviewRoutingStatus(validationResults);
    const completed = await this.stateMachine.completeValidation({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      to,
      validationResults,
    });
    if (completed === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }

    if (to === InvoiceStatus.GENERATING) {
      await publishNextStage({
        stateMachine: this.stateMachine,
        ownQueue: this.stageQueue,
        nextQueue: this.generationQueue,
        invoiceId: invoice.id,
        storageKey: invoice.storageKey,
      });
    }
    this.emitStageEvent(job, 'completed');
  }
}
