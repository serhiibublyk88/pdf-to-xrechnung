import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvoiceStatus, Prisma, Severity, SourceType } from '@prisma/client';
import {
  lifecycleTokenPattern,
  RawExtractedInvoiceDataSchema,
  type InvoiceFailure,
  type RawExtractedInvoiceData,
  type ReviewResult,
} from '@pdf-to-xrechnung/contracts';
import type { Env } from '../config/env.schema';
import { parseInvoiceFailure } from '../invoices/invoice-failure.schema';
import { LATEST_PARSED_ATTEMPT_RULE } from '../data-extraction/latest-extraction-attempt';
import { DataExtractionQueue } from '../data-extraction/data-extraction-queue.service';
import { TextExtractionQueue } from '../extraction/text-extraction-queue.service';
import { GenerationQueue } from '../generation/generation-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import {
  DeadLetterRetryUnavailableError,
  type PipelineStageQueue,
} from '../queue/pipeline-stage-queue';
import {
  reviewRoutingStatus,
  validateExtractedInvoice,
} from '../validation/invoice-validator';
import { ValidationQueue } from '../validation/validation-queue.service';

export interface InvoiceListItem {
  id: string;
  originalFilename: string;
  status: InvoiceStatus;
  createdAt: Date;
  expiresAt: Date;
  failure: InvoiceFailure | null;
}

interface InvoiceFinding {
  rule: string;
  field: string | null;
  severity: Severity;
  passed: boolean;
  message: string;
  expected: string | null;
  actual: string | null;
}

// The dead letter carries no failure text: the raw message is operator diagnostics.
interface InvoiceDeadLetter {
  stage: PipelineStage;
  failedAt: string;
}

interface InvoiceDetailBase {
  id: string;
  originalFilename: string;
  sourceType: SourceType;
  pageCount: number | null;
  failure: InvoiceFailure | null;
  expiresAt: Date;
  reviewedAt: Date | null;
  extractedData: RawExtractedInvoiceData | null;
  findings: InvoiceFinding[];
  deadLetter: InvoiceDeadLetter | null;
}

export type InvoiceDetail =
  | (InvoiceDetailBase & {
      status: typeof InvoiceStatus.NEEDS_REVIEW;
      lifecycleToken: string;
    })
  | (InvoiceDetailBase & {
      status: Exclude<InvoiceStatus, typeof InvoiceStatus.NEEDS_REVIEW>;
      lifecycleToken: null;
    });

interface ReviewLifecycle {
  storageKey: string;
  expiresAt: Date;
  reviewVersion: number;
}

interface DeadLetterLookup extends InvoiceDeadLetter {
  queue: PipelineStageQueue;
}

const OWNER_INVOICE_LIST_LIMIT = 100;

const DELETABLE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.NEEDS_REVIEW,
  InvoiceStatus.READY,
  InvoiceStatus.FAILED,
];

@Injectable()
export class ReviewService {
  private readonly sessionSecret: string;
  private readonly stages: {
    stage: PipelineStage;
    queue: PipelineStageQueue;
  }[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: InvoiceStateMachine,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly generationQueue: GenerationQueue,
    textExtractionQueue: TextExtractionQueue,
    dataExtractionQueue: DataExtractionQueue,
    validationQueue: ValidationQueue,
    configService: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReviewService.name);
    this.sessionSecret = configService.get('SESSION_SECRET');
    this.stages = [
      { stage: PipelineStage.TEXT_EXTRACTION, queue: textExtractionQueue },
      { stage: PipelineStage.DATA_EXTRACTION, queue: dataExtractionQueue },
      { stage: PipelineStage.VALIDATION, queue: validationQueue },
      { stage: PipelineStage.GENERATION, queue: generationQueue },
    ];
  }

  async list(ownerId: string): Promise<InvoiceListItem[]> {
    const invoices = await this.prisma.invoice.findMany({
      where: { ownerId, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        originalFilename: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        failureCode: true,
        failureParams: true,
      },
      orderBy: { createdAt: 'desc' },
      take: OWNER_INVOICE_LIST_LIMIT,
    });

    return invoices.map(({ failureCode, failureParams, ...invoice }) => ({
      ...invoice,
      failure: parseInvoiceFailure(
        { failureCode, failureParams, invoiceId: invoice.id },
        this.logger,
      ),
    }));
  }

  async deleteInvoice(id: string, ownerId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
      select: { id: true, storageKey: true, status: true },
    });
    if (!invoice) {
      throw new NotFoundException();
    }
    if (!DELETABLE_STATUSES.includes(invoice.status)) {
      throw new ConflictException('Invoice is still being processed');
    }

    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.pendingStorageDeletion.create({
          data: { storageKey: invoice.storageKey },
        });
        const { count } = await transaction.invoice.deleteMany({
          where: {
            id,
            ownerId,
            storageKey: invoice.storageKey,
            status: invoice.status,
          },
        });
        if (count === 0) {
          throw new ConflictException(
            'Invoice changed while it was being deleted',
          );
        }
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Invoice changed while it was being deleted',
        );
      }
      throw error;
    }

    let fileDeleted = false;
    try {
      await this.storage.delete(invoice.storageKey);
      fileDeleted = true;
    } catch (error) {
      this.logger.error(
        { err: error, invoiceId: invoice.id },
        'Failed to delete stored file',
      );
    }

    if (fileDeleted) {
      try {
        await this.prisma.pendingStorageDeletion.deleteMany({
          where: { storageKey: invoice.storageKey },
        });
      } catch (error) {
        this.logger.error(
          { err: error, invoiceId: invoice.id },
          'Failed to clear stored-file deletion marker',
        );
      }
    }
    await Promise.all(
      this.stages.map(({ stage, queue }) =>
        this.removeDeadLetter(stage, queue, invoice.id, invoice.storageKey),
      ),
    );
  }

  private async removeDeadLetter(
    stage: PipelineStage,
    queue: PipelineStageQueue,
    invoiceId: string,
    storageKey: string,
  ): Promise<void> {
    try {
      await queue.removeDeadLetter(invoiceId, storageKey);
    } catch (error) {
      this.logger.error(
        { err: error, invoiceId, stage },
        'Failed to remove dead-letter entry',
      );
    }
  }

  async detail(id: string, ownerId: string): Promise<InvoiceDetail | null> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        storageKey: true,
        originalFilename: true,
        status: true,
        sourceType: true,
        pageCount: true,
        failureCode: true,
        failureParams: true,
        expiresAt: true,
        reviewedAt: true,
        reviewVersion: true,
        reviewedData: true,
        attempts: {
          ...LATEST_PARSED_ATTEMPT_RULE,
          take: 1,
          select: { parsedData: true },
        },
        validations: {
          select: {
            rule: true,
            field: true,
            severity: true,
            passed: true,
            message: true,
            expected: true,
            actual: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!invoice) {
      return null;
    }

    const parsedData = RawExtractedInvoiceDataSchema.safeParse(
      invoice.reviewedData ?? invoice.attempts[0]?.parsedData,
    );
    const deadLetter = await this.deadLetterFor(invoice.id, invoice.storageKey);

    const failure = parseInvoiceFailure(
      {
        failureCode: invoice.failureCode,
        failureParams: invoice.failureParams,
        invoiceId: invoice.id,
      },
      this.logger,
    );
    const detail = {
      id: invoice.id,
      originalFilename: invoice.originalFilename,
      sourceType: invoice.sourceType,
      pageCount: invoice.pageCount,
      failure,
      expiresAt: invoice.expiresAt,
      reviewedAt: invoice.reviewedAt,
      extractedData: parsedData.success ? parsedData.data : null,
      findings: invoice.validations,
      deadLetter: deadLetter
        ? { stage: deadLetter.stage, failedAt: deadLetter.failedAt }
        : null,
    };
    if (invoice.status === InvoiceStatus.NEEDS_REVIEW) {
      return {
        ...detail,
        status: invoice.status,
        lifecycleToken: this.createLifecycleToken({
          id: invoice.id,
          ownerId,
          storageKey: invoice.storageKey,
          expiresAt: invoice.expiresAt,
          reviewVersion: invoice.reviewVersion,
        }),
      };
    }
    return { ...detail, status: invoice.status, lifecycleToken: null };
  }

  async review(
    id: string,
    ownerId: string,
    lifecycleToken: string,
    rawCorrectedData: unknown,
  ): Promise<ReviewResult> {
    const lifecycle = await this.currentReviewLifecycle(id, ownerId);
    if (
      !lifecycle ||
      !this.matchesLifecycleToken(lifecycleToken, { ...lifecycle, id, ownerId })
    ) {
      throw await this.unavailableReviewError(id, ownerId);
    }

    const parsedData =
      RawExtractedInvoiceDataSchema.safeParse(rawCorrectedData);
    if (!parsedData.success) {
      throw new BadRequestException(
        'Corrected invoice data has an invalid shape',
      );
    }

    const findings = validateExtractedInvoice(parsedData.data, new Date());
    const status = reviewRoutingStatus(findings);
    const persisted = await this.stateMachine.reviewCorrection({
      invoiceId: id,
      storageKey: lifecycle.storageKey,
      expectedReviewVersion: lifecycle.reviewVersion,
      correctedData: parsedData.data,
      findings,
      to: status,
    });

    if (persisted.outcome === 'lost') {
      throw await this.unavailableReviewError(id, ownerId);
    }

    if (status === InvoiceStatus.GENERATING) {
      await this.enqueueGeneration({ id, storageKey: lifecycle.storageKey });
    }

    if (status === InvoiceStatus.NEEDS_REVIEW) {
      return {
        status,
        lifecycleToken: this.createLifecycleToken({
          ...lifecycle,
          id,
          ownerId,
          reviewVersion: persisted.reviewVersion,
        }),
      };
    }
    return { status, lifecycleToken: null };
  }

  async retryDeadLetter(id: string, ownerId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
      select: { id: true, storageKey: true },
    });
    if (!invoice) {
      throw await this.unavailableReviewError(id, ownerId);
    }

    const deadLetter = await this.deadLetterFor(invoice.id, invoice.storageKey);
    if (!deadLetter) {
      throw new ConflictException('Invoice has no retriable dead-lettered job');
    }

    try {
      await deadLetter.queue.retryFromDlq(invoice.id);
    } catch (error) {
      if (error instanceof DeadLetterRetryUnavailableError) {
        throw new ConflictException(
          'The dead-lettered job is no longer retriable',
        );
      }
      throw error;
    }
  }

  private async enqueueGeneration(lifecycle: {
    id: string;
    storageKey: string;
  }): Promise<void> {
    try {
      await this.generationQueue.enqueue({
        invoiceId: lifecycle.id,
        storageKey: lifecycle.storageKey,
      });
    } catch (enqueueError) {
      try {
        const rollback = await this.stateMachine.transition({
          invoiceId: lifecycle.id,
          storageKey: lifecycle.storageKey,
          from: InvoiceStatus.GENERATING,
          to: InvoiceStatus.NEEDS_REVIEW,
        });
        if (rollback === 'lost') {
          this.logger.warn(
            { invoiceId: lifecycle.id },
            'Could not return invoice to review after its lifecycle moved',
          );
        }
      } catch (restoreError) {
        this.logger.error(
          { err: restoreError, invoiceId: lifecycle.id },
          'Could not return invoice to review after generation enqueue failed',
        );
      }
      this.logger.error(
        { err: enqueueError, invoiceId: lifecycle.id },
        'Could not enqueue regeneration',
      );
      throw new ServiceUnavailableException('Could not schedule regeneration');
    }
  }

  private async currentReviewLifecycle(
    id: string,
    ownerId: string,
  ): Promise<ReviewLifecycle | null> {
    return this.prisma.invoice.findFirst({
      where: {
        id,
        ownerId,
        status: InvoiceStatus.NEEDS_REVIEW,
        expiresAt: { gt: new Date() },
      },
      select: { storageKey: true, expiresAt: true, reviewVersion: true },
    });
  }

  private createLifecycleToken({
    id,
    ownerId,
    storageKey,
    expiresAt,
    reviewVersion,
  }: ReviewLifecycle & { id: string; ownerId: string }): string {
    return createHmac('sha256', this.sessionSecret)
      .update(
        `review.${id}.${ownerId}.${storageKey}.${expiresAt.toISOString()}.${reviewVersion}`,
      )
      .digest('hex');
  }

  private matchesLifecycleToken(
    lifecycleToken: string,
    lifecycle: ReviewLifecycle & { id: string; ownerId: string },
  ): boolean {
    if (!lifecycleTokenPattern.test(lifecycleToken)) {
      return false;
    }

    const expectedToken = this.createLifecycleToken(lifecycle);
    return timingSafeEqual(
      Buffer.from(lifecycleToken, 'hex'),
      Buffer.from(expectedToken, 'hex'),
    );
  }

  private async unavailableReviewError(
    id: string,
    ownerId: string,
  ): Promise<NotFoundException | ConflictException> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
      select: { status: true },
    });
    if (!invoice) {
      return new NotFoundException();
    }
    return new ConflictException(
      `Invoice cannot be corrected while it is ${invoice.status}`,
    );
  }

  private async deadLetterFor(
    invoiceId: string,
    storageKey: string,
  ): Promise<DeadLetterLookup | null> {
    const deadLetters = await Promise.all(
      this.stages.map(async ({ stage, queue }) => {
        const deadLetter = await queue.getDeadLetter(invoiceId, storageKey);
        return deadLetter
          ? { stage, queue, failedAt: deadLetter.failedAt }
          : null;
      }),
    );

    return (
      deadLetters
        .filter(
          (deadLetter): deadLetter is DeadLetterLookup => deadLetter !== null,
        )
        .sort((a, b) => b.failedAt.localeCompare(a.failedAt))[0] ?? null
    );
  }
}
