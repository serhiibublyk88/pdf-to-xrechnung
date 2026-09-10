import { InvoiceService } from '@e-invoice-eu/core';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { InvoiceStatus, Prisma, Severity } from '@prisma/client';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';
import { latestParsedExtractionAttempt } from '../data-extraction/latest-extraction-attempt';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import { PipelineStageProcessor } from '../queue/pipeline-stage.processor';
import type { FailedStageJob } from '../queue/pipeline-stage-queue';
import {
  GenerationQueue,
  type GenerationJobData,
} from './generation-queue.service';
import { KositClient } from './kosit-client';
import type { KositMessageLevel, KositReportMessage } from './kosit-report';
import {
  mappingFinding,
  mapToXRechnungInvoice,
  type MappingFinding,
} from './xrechnung-mapper';

const XRECHNUNG_UBL_FORMAT = 'XRECHNUNG-UBL';
const XRECHNUNG_LANG = 'de-de';

type GenerationFinding = Omit<
  Prisma.ValidationResultCreateManyInput,
  'invoiceId'
>;

const KOSIT_SEVERITY: Record<KositMessageLevel, Severity> = {
  error: Severity.ERROR,
  warning: Severity.WARNING,
  information: Severity.INFO,
};

const UNSPECIFIED_KOSIT_REJECTION: GenerationFinding = {
  rule: 'kosit.unspecified',
  field: null,
  severity: Severity.ERROR,
  passed: false,
  message: 'The KoSIT validator rejected the document without naming a rule.',
};

function kositRejectionFindings(
  messages: KositReportMessage[],
): GenerationFinding[] {
  if (messages.length === 0) {
    return [UNSPECIFIED_KOSIT_REJECTION];
  }
  return messages.map((message) => ({
    rule: `kosit.${message.code}`,
    field: null,
    severity: KOSIT_SEVERITY[message.level],
    passed: false,
    message: message.text,
  }));
}

@Processor(PipelineStage.GENERATION)
export class GenerationProcessor extends PipelineStageProcessor {
  private readonly invoiceService: InvoiceService;

  constructor(
    private readonly prisma: PrismaService,
    protected readonly stateMachine: InvoiceStateMachine,
    protected readonly stageQueue: GenerationQueue,
    private readonly kositClient: KositClient,
    protected readonly stageLogger: PinoLogger,
  ) {
    super();
    this.invoiceService = new InvoiceService(this.logger);
    this.stageLogger.setContext(GenerationProcessor.name);
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<GenerationJobData>): Promise<void> {
    try {
      const pendingRegeneration = await this.prisma.invoice.findFirst({
        where: {
          id: job.data.invoiceId,
          storageKey: job.data.storageKey,
          status: InvoiceStatus.GENERATING,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (pendingRegeneration) await this.stageQueue.enqueue(job.data);
    } catch (error) {
      this.stageLogger.error(
        { err: error, invoiceId: job.data.invoiceId },
        'Could not republish a regeneration requested during the previous run; startup reconciliation will retry',
      );
    }
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
        reviewedData: true,
      },
    });

    const invoice = await this.acceptStageJob(job, loaded);
    if (!invoice || !(await this.claimStage(invoice, job))) {
      return;
    }

    const parsedData = invoice.reviewedData
      ? undefined
      : await latestParsedExtractionAttempt(
          this.prisma,
          invoice.id,
          invoice.storageKey,
        );

    const schemaResult = RawExtractedInvoiceDataSchema.safeParse(
      invoice.reviewedData ?? parsedData,
    );
    if (!schemaResult.success) {
      await this.rejectMapping(job, invoice.id, invoice.storageKey, [
        mappingFinding(
          'mapping.schema',
          null,
          'Stored extracted data no longer matches the validation schema.',
        ),
      ]);
      return;
    }

    const mapping = mapToXRechnungInvoice(schemaResult.data);
    if (!mapping.ok) {
      await this.rejectMapping(
        job,
        invoice.id,
        invoice.storageKey,
        mapping.findings,
      );
      return;
    }

    let xml: string;
    try {
      const rendered = await this.invoiceService.generate(mapping.invoice, {
        format: XRECHNUNG_UBL_FORMAT,
        lang: XRECHNUNG_LANG,
      });
      xml =
        typeof rendered === 'string'
          ? rendered
          : Buffer.from(rendered).toString('utf8');
    } catch (error) {
      if (!isSchemaRejection(error)) {
        throw error;
      }
      await this.rejectMapping(job, invoice.id, invoice.storageKey, [
        mappingFinding(
          'mapping.generation_failed',
          null,
          schemaRejectionMessage(error),
        ),
      ]);
      return;
    }

    const { valid, reportXml, messages } = await this.kositClient.validate(xml);

    const completed = await this.stateMachine.completeGeneration({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      to: valid ? InvoiceStatus.READY : InvoiceStatus.NEEDS_REVIEW,
      document: {
        format: 'XRECHNUNG_UBL',
        xml,
        isValid: valid,
        kositReport: { xml: reportXml },
      },
      findings: valid ? [] : kositRejectionFindings(messages),
    });
    if (completed === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }
    this.emitStageEvent(job, 'completed');
  }

  private async rejectMapping(
    job: FailedStageJob,
    invoiceId: string,
    storageKey: string,
    findings: MappingFinding[],
  ): Promise<void> {
    const completed = await this.stateMachine.rejectGeneration({
      invoiceId,
      storageKey,
      findings,
    });
    if (completed === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }
    this.emitStageEvent(job, 'completed');
  }
}

function isSchemaRejection(error: unknown): boolean {
  return (
    error instanceof Error && 'errors' in error && Array.isArray(error.errors)
  );
}

const MAX_SCHEMA_REJECTION_PATHS = 3;

function schemaRejectionPaths(error: unknown): string[] {
  if (typeof error !== 'object' || error === null || !('errors' in error)) {
    return [];
  }
  const { errors } = error;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors
    .map((entry: unknown) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('instancePath' in entry)
      ) {
        return undefined;
      }
      const { instancePath } = entry;
      return typeof instancePath === 'string' ? instancePath : undefined;
    })
    .filter((path): path is string => path !== undefined);
}

function schemaRejectionMessage(error: unknown): string {
  const base =
    'The mapped invoice was rejected by the XRechnung UBL generator.';
  const paths = schemaRejectionPaths(error);
  if (paths.length === 0) {
    return base;
  }
  const shown = paths.slice(0, MAX_SCHEMA_REJECTION_PATHS).join(', ');
  const ellipsis = paths.length > MAX_SCHEMA_REJECTION_PATHS ? ', …' : '';
  return `${base} Rejected paths: ${shown}${ellipsis}`;
}
