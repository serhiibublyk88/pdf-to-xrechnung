import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import type { Env } from '../config/env.schema';
import {
  PdfResourceLimitError,
  RetryableTextExtractionError,
  assemblePageText,
  type PageText,
  type ExtractedText,
} from './text-extractor.interface';
import {
  MAX_OCR_RASTER_DIMENSION,
  MAX_OCR_STDERR_BYTES,
  MAX_OCR_STDOUT_BYTES,
} from './text-extraction-limits';
import { parseTesseractTsv, type RecognisedText } from './tesseract-tsv';

export interface OcrExtractedText extends ExtractedText {
  pages: Array<PageText & { meanConfidence: number }>;
}

const PDFTOCAIRO_DETERMINISTIC_EXIT_CODES = new Set([2, 99]);

const TESSERACT_LANGUAGES = 'deu+eng';

function commandError(
  command: string,
  exitCode: number | null,
  cause?: unknown,
): Error {
  const message = `OCR command ${command} exited with code ${exitCode ?? 'unknown'}`;
  const deterministic =
    command === 'pdftocairo' &&
    exitCode !== null &&
    PDFTOCAIRO_DETERMINISTIC_EXIT_CODES.has(exitCode);
  return deterministic
    ? new Error(message, { cause })
    : new RetryableTextExtractionError(message, { cause });
}

export function runOcrCommand(
  command: string,
  arguments_: string[],
  input: Buffer | undefined,
  deadline: number,
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(
      new RetryableTextExtractionError(
        'OCR extraction exceeded its time limit',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() =>
        reject(
          new RetryableTextExtractionError(
            'OCR extraction exceeded its time limit',
          ),
        ),
      );
    }, remainingMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OCR_STDOUT_BYTES) {
        child.kill('SIGKILL');
        settle(() =>
          reject(
            new PdfResourceLimitError(
              'OCR command output exceeded its resource limit',
            ),
          ),
        );
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OCR_STDERR_BYTES) {
        child.kill('SIGKILL');
        settle(() =>
          reject(
            new PdfResourceLimitError(
              'OCR command output exceeded its resource limit',
            ),
          ),
        );
      }
    });
    child.once('error', (error) =>
      settle(() => reject(commandError(command, null, error))),
    );
    child.once('close', (code) => {
      if (code === 0) {
        settle(() => resolve(Buffer.concat(output)));
        return;
      }
      settle(() => reject(commandError(command, code)));
    });
    child.stdin.once('error', (error) =>
      settle(() => reject(commandError(command, null, error))),
    );
    child.stdin.end(input);
  });
}

@Injectable()
export class OcrTextExtractor implements OnModuleInit {
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<Env, true>) {
    this.timeoutMs = configService.get('OCR_TIMEOUT_MS');
  }

  async onModuleInit(): Promise<void> {
    try {
      await runOcrCommand(
        'tesseract',
        ['--print-parameters', '-l', TESSERACT_LANGUAGES],
        undefined,
        Date.now() + this.timeoutMs,
      );
    } catch (error) {
      throw new Error(
        'OCR requires the tesseract binary; install tesseract-ocr and tesseract-ocr-deu',
        { cause: error },
      );
    }
    try {
      await runOcrCommand(
        'pdftocairo',
        ['-v'],
        undefined,
        Date.now() + this.timeoutMs,
      );
    } catch (error) {
      throw new Error(
        'OCR requires the pdftocairo binary; install poppler-utils',
        { cause: error },
      );
    }
  }

  async extract(pdf: Buffer, pageCount: number): Promise<OcrExtractedText> {
    const deadline = Date.now() + this.timeoutMs * pageCount;
    const pages: { pageNumber: number; recognisedText: RecognisedText }[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageImage = await runOcrCommand(
        'pdftocairo',
        [
          '-png',
          '-scale-to',
          String(MAX_OCR_RASTER_DIMENSION),
          '-gray',
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          '-singlefile',
          '-',
          '-',
        ],
        pdf,
        deadline,
      );
      const tsv = await runOcrCommand(
        'tesseract',
        ['-', '-', '-l', TESSERACT_LANGUAGES, 'tsv'],
        pageImage,
        deadline,
      );
      let recognisedText;
      try {
        recognisedText = parseTesseractTsv(tsv.toString('utf8'));
      } catch (error) {
        throw new RetryableTextExtractionError(
          'Tesseract returned invalid TSV',
          {
            cause: error,
          },
        );
      }
      pages.push({ pageNumber, recognisedText });
    }

    const { text, charCount } = assemblePageText(
      pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.recognisedText.text,
      })),
    );
    const extractedPages = pages.map((page) => ({
      pageNumber: page.pageNumber,
      charCount: page.recognisedText.text.length,
      meanConfidence: page.recognisedText.meanConfidence,
    }));
    return { text, pageCount, charCount, pages: extractedPages };
  }
}
