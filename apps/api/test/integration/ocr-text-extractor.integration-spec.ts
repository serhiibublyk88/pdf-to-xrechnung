import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_OCR_MIN_MEAN_CONFIDENCE,
  type Env,
} from '../../src/config/env.schema';
import {
  OcrTextExtractor,
  runOcrCommand,
} from '../../src/extraction/ocr-text-extractor';
import {
  PdfResourceLimitError,
  RetryableTextExtractionError,
} from '../../src/extraction/text-extractor.interface';

const ONE_PAGE_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '0',
    '%%EOF',
  ].join('\n'),
);

const HUGE_PAGE_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 20000 20000]>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '0',
    '%%EOF',
  ].join('\n'),
);

describe('OCR binaries', () => {
  jest.setTimeout(60_000);

  it('reports a missing command with its unavailable exit code, and retries it', async () => {
    const failure = runOcrCommand(
      'missing-ocr-binary',
      [],
      undefined,
      Date.now() + 1_000,
    );

    await expect(failure).rejects.toThrow(
      'OCR command missing-ocr-binary exited with code unknown',
    );
    await expect(failure).rejects.toBeInstanceOf(RetryableTextExtractionError);
  });

  it('rejects an exhausted deadline before spawning anything, as retryable', async () => {
    await expect(
      runOcrCommand('pdftocairo', ['-v'], undefined, Date.now() - 1),
    ).rejects.toBeInstanceOf(RetryableTextExtractionError);
  });

  it('treats a page request out of range as deterministic, not for retry', async () => {
    const failure = runOcrCommand(
      'pdftocairo',
      ['-png', '-f', '5', '-l', '5', '-singlefile', '-', '-'],
      ONE_PAGE_PDF,
      Date.now() + 10_000,
    );

    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.not.toBeInstanceOf(
      RetryableTextExtractionError,
    );
  });

  it('treats a page too large for cairo as deterministic, not for retry', async () => {
    const failure = runOcrCommand(
      'pdftocairo',
      ['-png', '-f', '1', '-l', '1', '-singlefile', '-', '-'],
      HUGE_PAGE_PDF,
      Date.now() + 10_000,
    );

    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.not.toBeInstanceOf(
      RetryableTextExtractionError,
    );
  });

  it('boots on a host with tesseract, pdftocairo and real language data installed', async () => {
    const extractor = new OcrTextExtractor(
      new ConfigService<Env, true>({ OCR_TIMEOUT_MS: 10_000 }),
    );

    await expect(extractor.onModuleInit()).resolves.toBeUndefined();
  });

  it('rejects the language-data probe onModuleInit runs when the language data is missing', async () => {
    const emptyTessdataDir = await mkdtemp(join(tmpdir(), 'tessdata-empty-'));

    try {
      await expect(
        runOcrCommand(
          'tesseract',
          ['--print-parameters', '-l', 'deu+eng'],
          undefined,
          Date.now() + 10_000,
          { ...process.env, TESSDATA_PREFIX: emptyTessdataDir },
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(emptyTessdataDir, { recursive: true, force: true });
    }
  });

  it('does not include child diagnostics in a failed command error', async () => {
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'printf private-child-output >&2; exit 7'],
        undefined,
        Date.now() + 1_000,
      ),
    ).rejects.toThrow('OCR command sh exited with code 7');
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'printf private-child-output >&2; exit 7'],
        undefined,
        Date.now() + 1_000,
      ),
    ).rejects.not.toThrow('private-child-output');
  });

  it('returns command stdout on success', async () => {
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'printf recognised-text'],
        undefined,
        Date.now() + 1_000,
      ),
    ).resolves.toEqual(Buffer.from('recognised-text'));
  });

  it('terminates a command whose stdout exceeds the resource limit', async () => {
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'head -c 17000000 /dev/zero'],
        undefined,
        Date.now() + 10_000,
      ),
    ).rejects.toThrow('OCR command output exceeded its resource limit');
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'head -c 17000000 /dev/zero'],
        undefined,
        Date.now() + 10_000,
      ),
    ).rejects.toBeInstanceOf(PdfResourceLimitError);
  });

  it('terminates a command whose stderr exceeds the resource limit', async () => {
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'head -c 17000000 /dev/zero >&2'],
        undefined,
        Date.now() + 10_000,
      ),
    ).rejects.toThrow('OCR command output exceeded its resource limit');
    await expect(
      runOcrCommand(
        'sh',
        ['-c', 'head -c 17000000 /dev/zero >&2'],
        undefined,
        Date.now() + 10_000,
      ),
    ).rejects.toBeInstanceOf(PdfResourceLimitError);
  });

  it('terminates a command that exceeds its deadline', async () => {
    await expect(
      runOcrCommand('sh', ['-c', 'sleep 1'], undefined, Date.now() + 1),
    ).rejects.toThrow('OCR extraction exceeded its time limit');
  });

  it('assembles a scanned invoice with the native page marker format', async () => {
    const extractor = new OcrTextExtractor(
      new ConfigService<Env, true>({ OCR_TIMEOUT_MS: 15_000 }),
    );
    const pdf = readFileSync(
      join(__dirname, '../../evals/dataset/011-scan-clean-de/invoice.pdf'),
    );

    await extractor.onModuleInit();
    const extracted = await extractor.extract(pdf, 1);

    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain('--- PAGE 1 ---');
    expect(extracted.text).toContain('RE-2026-0001');
    expect(extracted.pages[0]?.charCount).toBeGreaterThan(50);
    expect(extracted.pages[0]?.meanConfidence).toBeGreaterThan(0);
  });

  it('reads every page of a multi-page image-only PDF within its scaled budget', async () => {
    const extractor = new OcrTextExtractor(
      new ConfigService<Env, true>({ OCR_TIMEOUT_MS: 15_000 }),
    );
    const pdf = readFileSync(
      join(__dirname, '../../evals/dataset/017-multipage-scan-de/invoice.pdf'),
    );

    const extracted = await extractor.extract(pdf, 2);

    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages.every((page) => page.charCount > 50)).toBe(true);
  });

  it('keeps the retuned degraded scan above the confidence gate', async () => {
    const extractor = new OcrTextExtractor(
      new ConfigService<Env, true>({ OCR_TIMEOUT_MS: 15_000 }),
    );
    const pdf = readFileSync(
      join(__dirname, '../../evals/dataset/012-scan-degraded-de/invoice.pdf'),
    );

    const extracted = await extractor.extract(pdf, 1);

    expect(extracted.pages[0]?.meanConfidence).toBeGreaterThanOrEqual(
      DEFAULT_OCR_MIN_MEAN_CONFIDENCE,
    );
  });

  it('puts the illegible scan below the confidence gate', async () => {
    const extractor = new OcrTextExtractor(
      new ConfigService<Env, true>({ OCR_TIMEOUT_MS: 15_000 }),
    );
    const pdf = readFileSync(
      join(__dirname, '../../evals/dataset/018-illegible-scan-de/invoice.pdf'),
    );

    const extracted = await extractor.extract(pdf, 1);

    expect(extracted.pages[0]?.charCount).toBeGreaterThan(50);
    expect(extracted.pages[0]?.meanConfidence).toBeLessThan(
      DEFAULT_OCR_MIN_MEAN_CONFIDENCE,
    );
  });
});
