import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Env } from '../config/env.schema';
import {
  PdfResourceLimitError,
  RetryableTextExtractionError,
  TextTooLongError,
  TooManyPagesError,
  assemblePageText,
  type ExtractedText,
  type TextExtractor,
} from './text-extractor.interface';
import {
  MAX_NATIVE_TEXT_WORKER_OLD_SPACE_MB,
  MAX_NATIVE_TEXT_WORKER_YOUNG_SPACE_MB,
} from './text-extraction-limits';

interface PdfTextResult {
  total: number;
  pages: Array<{ pageNumber: number; text: string }>;
}

type WorkerResult =
  | ({ ok: true } & PdfTextResult)
  | { ok: false; type: 'too_many_pages'; pageCount: number }
  | { ok: false; type: 'text_too_long'; charCount: number }
  | { ok: false; type: 'error'; message: string };

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false;
  if (value.ok === false) {
    if (!('type' in value) || typeof value.type !== 'string') return false;
    if (value.type === 'too_many_pages') {
      return 'pageCount' in value && typeof value.pageCount === 'number';
    }
    if (value.type === 'text_too_long') {
      return 'charCount' in value && typeof value.charCount === 'number';
    }
    return (
      value.type === 'error' &&
      'message' in value &&
      typeof value.message === 'string'
    );
  }
  return (
    value.ok === true &&
    'total' in value &&
    typeof value.total === 'number' &&
    'pages' in value &&
    Array.isArray(value.pages) &&
    value.pages.every(
      (page: unknown) =>
        typeof page === 'object' &&
        page !== null &&
        'pageNumber' in page &&
        typeof page.pageNumber === 'number' &&
        'text' in page &&
        typeof page.text === 'string',
    )
  );
}

function isWorkerMemoryLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_WORKER_OUT_OF_MEMORY'
  );
}

function extractPdfText(
  pdf: Buffer,
  timeoutMs: number,
  maxPages: number,
  maxExtractedTextChars: number,
): Promise<PdfTextResult> {
  const worker = new Worker(join(__dirname, 'pdf-text.worker.mjs'), {
    resourceLimits: {
      maxOldGenerationSizeMb: MAX_NATIVE_TEXT_WORKER_OLD_SPACE_MB,
      maxYoungGenerationSizeMb: MAX_NATIVE_TEXT_WORKER_YOUNG_SPACE_MB,
    },
    workerData: { pdf, maxPages, maxExtractedTextChars },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker
        .terminate()
        .then(callback)
        .catch((error: unknown) => {
          reject(
            error instanceof Error
              ? new RetryableTextExtractionError(error.message, {
                  cause: error,
                })
              : new RetryableTextExtractionError(String(error)),
          );
        });
    };

    worker.once('message', (value: unknown) => {
      if (!isWorkerResult(value)) {
        finish(() =>
          reject(
            new RetryableTextExtractionError(
              'PDF text worker returned invalid data',
            ),
          ),
        );
      } else if (!value.ok) {
        finish(() =>
          reject(
            value.type === 'too_many_pages'
              ? new TooManyPagesError(value.pageCount, maxPages)
              : value.type === 'text_too_long'
                ? new TextTooLongError(value.charCount, maxExtractedTextChars)
                : new Error(value.message),
          ),
        );
      } else {
        finish(() => resolve({ total: value.total, pages: value.pages }));
      }
    });
    worker.once('error', (error: unknown) =>
      finish(() =>
        reject(
          isWorkerMemoryLimitError(error)
            ? new PdfResourceLimitError('PDF resource limit exceeded')
            : error instanceof Error
              ? new RetryableTextExtractionError(error.message, {
                  cause: error,
                })
              : new RetryableTextExtractionError(String(error)),
        ),
      ),
    );
    worker.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new RetryableTextExtractionError(
            `PDF text worker exited before returning data (${code})`,
          ),
        );
      }
    });
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new RetryableTextExtractionError(
              `PDF text extraction exceeded ${timeoutMs} ms`,
            ),
          ),
        ),
      timeoutMs,
    );
  });
}

@Injectable()
export class NativeTextExtractor implements TextExtractor {
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxExtractedTextChars: number;

  constructor(configService: ConfigService<Env, true>) {
    this.timeoutMs = configService.get('NATIVE_TEXT_TIMEOUT_MS');
    this.maxPages = configService.get('MAX_PAGES');
    this.maxExtractedTextChars = configService.get('MAX_EXTRACTED_TEXT_CHARS');
  }

  async extract(pdf: Buffer): Promise<ExtractedText> {
    const pdfText = await extractPdfText(
      pdf,
      this.timeoutMs,
      this.maxPages,
      this.maxExtractedTextChars,
    );
    const pages = pdfText.pages.map((page) => ({
      pageNumber: page.pageNumber,
      charCount: page.text.length,
    }));
    const { text, charCount } = assemblePageText(pdfText.pages);
    return { text, pageCount: pdfText.total, charCount, pages };
  }
}
