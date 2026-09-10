import { Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoiceStatus, SourceType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';
import type { Env } from '../config/env.schema';
import { DataExtractionQueue } from '../data-extraction/data-extraction-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvoiceStateMachine,
  type TransitionPatch,
} from '../queue/invoice-state-machine';
import { PipelineStage } from '../queue/pipeline-stage';
import { PipelineStageProcessor } from '../queue/pipeline-stage.processor';
import {
  publishNextStage,
  type FailedStageJob,
} from '../queue/pipeline-stage-queue';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { TextExtractionQueue } from './text-extraction-queue.service';
import {
  PdfResourceLimitError,
  RetryableTextExtractionError,
  TextTooLongError,
  TEXT_EXTRACTOR,
  TooManyPagesError,
} from './text-extractor.interface';
import type { ExtractedText, TextExtractor } from './text-extractor.interface';
import { OcrTextExtractor, type OcrExtractedText } from './ocr-text-extractor';

type LifecycleInvoice = { id: string; storageKey: string };

@Processor(PipelineStage.TEXT_EXTRACTION)
export class TextExtractionProcessor extends PipelineStageProcessor {
  private readonly minCharsPerPage: number;
  private readonly minOcrCharsPerPage: number;
  private readonly minOcrMeanConfidence: number;
  private readonly maxExtractedTextChars: number;

  constructor(
    private readonly prisma: PrismaService,
    protected readonly stateMachine: InvoiceStateMachine,
    protected readonly stageQueue: TextExtractionQueue,
    private readonly dataExtractionQueue: DataExtractionQueue,
    configService: ConfigService<Env, true>,
    @Inject(TEXT_EXTRACTOR) private readonly textExtractor: TextExtractor,
    private readonly ocrTextExtractor: OcrTextExtractor,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    protected readonly stageLogger: PinoLogger,
  ) {
    super();
    this.stageLogger.setContext(TextExtractionProcessor.name);
    this.minCharsPerPage = configService.get('NATIVE_TEXT_MIN_CHARS_PER_PAGE');
    this.minOcrCharsPerPage = configService.get('OCR_MIN_CHARS_PER_PAGE');
    this.minOcrMeanConfidence = configService.get('OCR_MIN_MEAN_CONFIDENCE');
    this.maxExtractedTextChars = configService.get('MAX_EXTRACTED_TEXT_CHARS');
  }

  protected async processInvoice(job: FailedStageJob): Promise<void> {
    const loaded = await this.prisma.invoice.findUnique({
      where: { id: job.data.invoiceId },
    });

    const invoice = await this.acceptStageJob(job, loaded);
    if (!invoice || !(await this.claimStage(invoice, job))) {
      return;
    }

    const pdf = await this.storage.read(invoice.storageKey);

    let extracted: ExtractedText;
    try {
      extracted = await this.textExtractor.extract(pdf);
    } catch (error) {
      if (error instanceof RetryableTextExtractionError) {
        throw error;
      }
      if (error instanceof PdfResourceLimitError) {
        await this.failExtraction(job, invoice, { code: 'pdf_resource_limit' });
        return;
      }
      if (error instanceof TooManyPagesError) {
        await this.failExtraction(
          job,
          invoice,
          {
            code: 'pdf_too_many_pages',
            params: { pageCount: error.pageCount, limit: error.limit },
          },
          { pageCount: error.pageCount },
        );
        return;
      }
      if (error instanceof TextTooLongError) {
        await this.failExtraction(job, invoice, {
          code: 'text_too_long',
          params: { charCount: error.charCount, limit: error.limit },
        });
        return;
      }
      this.stageLogger.error(
        { err: error, invoiceId: invoice.id },
        'Text extraction failed',
      );
      await this.failExtraction(job, invoice, { code: 'pdf_unreadable' });
      return;
    }

    if (extracted.pageCount === 0) {
      await this.failExtraction(job, invoice, { code: 'pdf_no_pages' });
      return;
    }

    let sourceType: SourceType = SourceType.NATIVE;
    if (
      extracted.pages.every((page) => page.charCount < this.minCharsPerPage)
    ) {
      const ocr = await this.extractByOcr(
        job,
        invoice,
        pdf,
        extracted.pageCount,
      );
      if (!ocr) {
        return;
      }
      extracted = ocr;
      sourceType = SourceType.OCR;
    }

    if (extracted.charCount > this.maxExtractedTextChars) {
      await this.failExtraction(
        job,
        invoice,
        {
          code: 'text_too_long',
          params: {
            charCount: extracted.charCount,
            limit: this.maxExtractedTextChars,
          },
        },
        { pageCount: extracted.pageCount, textCharCount: extracted.charCount },
      );
      return;
    }

    const transitionOutcome = await this.stateMachine.transition({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.TEXT_READY,
      data: {
        sourceType,
        pageCount: extracted.pageCount,
        extractedText: extracted.text,
        textCharCount: extracted.charCount,
      },
    });
    if (transitionOutcome === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }

    await publishNextStage({
      stateMachine: this.stateMachine,
      ownQueue: this.stageQueue,
      nextQueue: this.dataExtractionQueue,
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });
    this.emitStageEvent(job, 'completed');
  }

  private async extractByOcr(
    job: FailedStageJob,
    invoice: LifecycleInvoice,
    pdf: Buffer,
    pageCount: number,
  ): Promise<ExtractedText | null> {
    let extracted: OcrExtractedText;
    try {
      extracted = await this.ocrTextExtractor.extract(pdf, pageCount);
    } catch (error) {
      if (error instanceof RetryableTextExtractionError) throw error;
      if (error instanceof PdfResourceLimitError) {
        await this.failExtraction(job, invoice, { code: 'pdf_resource_limit' });
        return null;
      }
      this.stageLogger.error(
        { err: error, invoiceId: invoice.id },
        'OCR extraction failed',
      );
      await this.failExtraction(job, invoice, { code: 'pdf_unreadable' });
      return null;
    }

    const patch = {
      sourceType: SourceType.OCR,
      pageCount: extracted.pageCount,
      textCharCount: extracted.charCount,
    };

    const contentPages = extracted.pages.filter(
      (page) => page.charCount >= this.minOcrCharsPerPage,
    );
    if (contentPages.length === 0) {
      await this.failExtraction(
        job,
        invoice,
        {
          code: 'ocr_text_too_sparse',
          params: { pages: extracted.pages.map((page) => page.pageNumber) },
        },
        patch,
      );
      return null;
    }

    const lowestPageConfidence = Math.min(
      ...contentPages.map((page) => page.meanConfidence),
    );
    if (lowestPageConfidence < this.minOcrMeanConfidence) {
      await this.failExtraction(
        job,
        invoice,
        {
          code: 'ocr_confidence_too_low',
          params: {
            lowestPageConfidence,
            minimum: this.minOcrMeanConfidence,
          },
        },
        patch,
      );
      return null;
    }

    return extracted;
  }

  private async failExtraction(
    job: FailedStageJob,
    invoice: LifecycleInvoice,
    failure: InvoiceFailure,
    patch: TransitionPatch = {},
  ): Promise<void> {
    const transitionOutcome = await this.stateMachine.transition({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { ...patch, failure },
    });
    if (transitionOutcome === 'lost') {
      this.emitStageEvent(job, 'lost-claim');
      return;
    }
    this.emitStageEvent(job, 'failed');
  }
}
