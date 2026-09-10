import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { createHash, randomUUID } from 'node:crypto';
import { Invoice, InvoiceStatus, Prisma, SourceType } from '@prisma/client';
import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';
import type { Env } from '../config/env.schema';
import { parseInvoiceFailure } from './invoice-failure.schema';
import { TextExtractionQueue } from '../extraction/text-extraction-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { isMissingFileError } from '../storage/missing-file-error';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';

const PDF_MAGIC_BYTES = Buffer.from('%PDF-', 'ascii');
const MAX_FIND_OR_CREATE_RETRIES = 3;

export interface IngestInput {
  ownerId: string;
  file: UploadedPdf;
}

export interface UploadedPdf {
  buffer: Buffer;
  originalname: string;
}

export interface UploadAcceptedResult {
  id: string;
  status: InvoiceStatus;
  deduplicated: boolean;
}

export interface InvoiceStatusResult {
  id: string;
  status: InvoiceStatus;
  sourceType: SourceType;
  pageCount: number | null;
  failure: InvoiceFailure | null;
}

export interface GeneratedDocumentResult {
  filename: string;
  xml: string;
}

export interface SourceDocumentResult {
  filename: string;
  pdf: Buffer;
}

interface FindOrCreateResult {
  invoice: Invoice;
  isNew: boolean;
}

interface FindOrCreateInput {
  ownerId: string;
  fileHash: string;
  file: UploadedPdf;
}

@Injectable()
export class InvoicesService {
  private readonly retentionHours: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService<Env, true>,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly textExtractionQueue: TextExtractionQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvoicesService.name);
    this.retentionHours = configService.get('RETENTION_HOURS');
  }

  async ingest({ ownerId, file }: IngestInput): Promise<UploadAcceptedResult> {
    if (file.buffer.subarray(0, 1024).indexOf(PDF_MAGIC_BYTES) === -1) {
      throw new BadRequestException('File is not a valid PDF');
    }

    const fileHash = createHash('sha256').update(file.buffer).digest('hex');

    const { invoice, isNew } = await this.findOrCreateInvoice({
      ownerId,
      fileHash,
      file,
    });

    const deduplicated = !isNew;
    if (deduplicated && invoice.status !== InvoiceStatus.UPLOADED) {
      return { ...this.toResult(invoice), deduplicated };
    }

    try {
      await this.storage.save(invoice.storageKey, file.buffer);
    } catch (error) {
      this.logger.error(
        { err: error, invoiceId: invoice.id },
        'Failed to store uploaded file',
      );
      throw new ServiceUnavailableException(
        'Could not store the uploaded file',
      );
    }

    await this.textExtractionQueue.enqueue({
      invoiceId: invoice.id,
      storageKey: invoice.storageKey,
    });

    return { ...this.toResult(invoice), deduplicated };
  }

  private async findOrCreateInvoice({
    ownerId,
    fileHash,
    file,
  }: FindOrCreateInput): Promise<FindOrCreateResult> {
    let lastConflict: Prisma.PrismaClientKnownRequestError | undefined;

    for (let attempt = 0; attempt <= MAX_FIND_OR_CREATE_RETRIES; attempt++) {
      try {
        const invoice = await this.prisma.invoice.create({
          data: {
            ownerId,
            fileHash,
            storageKey: randomUUID(),
            originalFilename: file.originalname,
            fileSizeBytes: file.buffer.length,
            expiresAt: new Date(
              Date.now() + this.retentionHours * 60 * 60 * 1000,
            ),
          },
        });
        return { invoice, isNew: true };
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }

        lastConflict = error;
        const existing = await this.prisma.invoice.findUnique({
          where: { ownerId_fileHash: { ownerId, fileHash } },
        });
        if (!existing) {
          continue;
        }
        if (existing.expiresAt > new Date()) {
          return { invoice: existing, isNew: false };
        }

        const refreshed = await this.resurrect(existing, file);
        if (refreshed) {
          return { invoice: refreshed, isNew: true };
        }
      }
    }

    throw lastConflict ?? new Error('Could not create or recover invoice');
  }

  private async resurrect(
    expired: Invoice,
    file: UploadedPdf,
  ): Promise<Invoice | null> {
    await this.storage.delete(expired.storageKey);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: expired.id, expiresAt: { lte: now } },
        data: {
          status: InvoiceStatus.UPLOADED,
          sourceType: SourceType.UNKNOWN,
          storageKey: randomUUID(),
          originalFilename: file.originalname,
          fileSizeBytes: file.buffer.length,
          pageCount: null,
          extractedText: null,
          textCharCount: null,
          reviewedData: Prisma.DbNull,
          failureCode: null,
          failureParams: Prisma.DbNull,
          reviewedAt: null,
          reviewVersion: 0,
          createdAt: now,
          expiresAt: new Date(
            now.getTime() + this.retentionHours * 60 * 60 * 1000,
          ),
        },
      });
      if (count === 0) {
        return null;
      }

      await tx.extractionAttempt.deleteMany({
        where: { invoiceId: expired.id },
      });
      await tx.validationResult.deleteMany({
        where: { invoiceId: expired.id },
      });
      await tx.generatedDocument.deleteMany({
        where: { invoiceId: expired.id },
      });

      return tx.invoice.findUniqueOrThrow({ where: { id: expired.id } });
    });
  }

  private toResult(
    invoice: Invoice,
  ): Omit<UploadAcceptedResult, 'deduplicated'> {
    return { id: invoice.id, status: invoice.status };
  }

  async findForOwner(
    id: string,
    ownerId: string,
  ): Promise<InvoiceStatusResult | null> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
    });
    if (!invoice) {
      return null;
    }
    const failure = parseInvoiceFailure(
      {
        failureCode: invoice.failureCode,
        failureParams: invoice.failureParams,
        invoiceId: invoice.id,
      },
      this.logger,
    );
    return {
      id: invoice.id,
      status: invoice.status,
      sourceType: invoice.sourceType,
      pageCount: invoice.pageCount,
      failure,
    };
  }

  async getGeneratedDocument(
    id: string,
    ownerId: string,
  ): Promise<GeneratedDocumentResult | null> {
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id,
        ownerId,
        status: InvoiceStatus.READY,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!invoice) {
      return null;
    }

    const document = await this.prisma.generatedDocument.findFirst({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: 'desc' },
      select: { xml: true },
    });
    if (!document) {
      return null;
    }

    return { filename: `xrechnung-${invoice.id}.xml`, xml: document.xml };
  }

  async getSourceDocument(
    id: string,
    ownerId: string,
  ): Promise<SourceDocumentResult | null> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, ownerId, expiresAt: { gt: new Date() } },
      select: { originalFilename: true, storageKey: true },
    });
    if (!invoice) {
      return null;
    }

    try {
      const pdf = await this.storage.read(invoice.storageKey);
      return { filename: invoice.originalFilename, pdf };
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new NotFoundException();
      }
      this.logger.error(
        { err: error, invoiceId: id },
        'Failed to read uploaded PDF',
      );
      throw new ServiceUnavailableException('Could not read the uploaded PDF');
    }
  }
}
