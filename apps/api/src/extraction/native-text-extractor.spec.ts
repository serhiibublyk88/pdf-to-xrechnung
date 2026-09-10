import { ConfigService } from '@nestjs/config';
import {
  buildImagePdf,
  buildMultiPagePdf,
  buildZeroPagePdf,
} from '../../evals/pdf-builders';
import type { Env } from '../config/env.schema';
import { NativeTextExtractor } from './native-text-extractor';
import { RetryableTextExtractionError } from './text-extractor.interface';

function createExtractor(timeoutMs = 30_000): NativeTextExtractor {
  return new NativeTextExtractor(
    new ConfigService<Env, true>({
      NATIVE_TEXT_TIMEOUT_MS: timeoutMs,
      MAX_PAGES: 30,
      MAX_EXTRACTED_TEXT_CHARS: 500_000,
    }),
  );
}

describe('NativeTextExtractor', () => {
  it('marks pages with "--- PAGE N ---" and reports a char count', async () => {
    const extractor = createExtractor();
    const pdf = buildMultiPagePdf(['Rechnungsnummer RE-2026-001']);

    const extracted = await extractor.extract(pdf);

    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain('--- PAGE 1 ---');
    expect(extracted.text).toContain('Rechnungsnummer RE-2026-001');
    expect(extracted.charCount).toBeGreaterThan(0);
    expect(extracted.pages).toEqual([
      { pageNumber: 1, charCount: extracted.charCount },
    ]);
  });

  it('reports a usable char count for every page of a normal multi-page invoice', async () => {
    const extractor = createExtractor();
    const pdf = buildMultiPagePdf([
      'Rechnungsnummer RE-2026-002 Seite 1 von 2',
      'Gesamtbetrag 100,00 EUR Seite 2 von 2',
    ]);

    const extracted = await extractor.extract(pdf);

    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages[0]?.pageNumber).toBe(1);
    expect(extracted.pages[1]?.pageNumber).toBe(2);
    expect(extracted.pages[0]?.charCount).toBeGreaterThan(0);
    expect(extracted.pages[1]?.charCount).toBeGreaterThan(0);
  });

  it('reports zero characters for a page with no text operators, the same signature a rasterised page has', async () => {
    const extractor = createExtractor();
    const pdf = buildMultiPagePdf([
      'Rechnungsnummer RE-2026-003 mit Text auf Seite 1',
      null,
    ]);

    const extracted = await extractor.extract(pdf);

    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages[0]?.charCount).toBeGreaterThan(0);
    expect(extracted.pages[1]?.charCount).toBe(0);
  });

  it('reports no native text for a PDF whose page is only an image', async () => {
    const extractor = createExtractor();
    const pdf = buildImagePdf({
      jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      width: 1,
      height: 1,
    });

    const extracted = await extractor.extract(pdf);

    expect(extracted.pageCount).toBe(1);
    expect(extracted.pages).toEqual([{ pageNumber: 1, charCount: 0 }]);
  });

  it('terminates extraction that exceeds its configured time limit', async () => {
    const extractor = createExtractor(1);
    const pdf = buildMultiPagePdf(['Rechnungsnummer RE-2026-004']);

    await expect(extractor.extract(pdf)).rejects.toBeInstanceOf(
      RetryableTextExtractionError,
    );
  });

  it('rejects text over the cap before returning it from the worker', async () => {
    const extractor = new NativeTextExtractor(
      new ConfigService<Env, true>({
        NATIVE_TEXT_TIMEOUT_MS: 30_000,
        MAX_PAGES: 30,
        MAX_EXTRACTED_TEXT_CHARS: 10,
      }),
    );

    await expect(
      extractor.extract(buildMultiPagePdf(['Rechnungsnummer RE-2026-004'])),
    ).rejects.toThrow('PDF text exceeds the configured character limit');
  });

  it('resolves a zero-page PDF instead of classifying it as a parse failure', async () => {
    const extractor = createExtractor();

    const extracted = await extractor.extract(buildZeroPagePdf());

    expect(extracted).toEqual({
      text: '',
      pageCount: 0,
      charCount: 0,
      pages: [],
    });
  });

  const validPdf = buildMultiPagePdf(['Rechnungsnummer RE-2026-005']);
  const truncatedPdf = validPdf.subarray(0, Math.floor(validPdf.length / 2));

  it.each([
    ['an empty buffer', Buffer.alloc(0)],
    ['bytes that are not a PDF at all', Buffer.from('not a pdf, just text')],
    ['a valid PDF truncated mid-structure', truncatedPdf],
  ])(
    'rejects %s deterministically, not as a retryable failure',
    async (_label, pdf) => {
      const extractor = createExtractor();

      const failure = extractor.extract(pdf);

      await expect(failure).rejects.toBeInstanceOf(Error);
      await expect(failure).rejects.not.toBeInstanceOf(
        RetryableTextExtractionError,
      );
    },
  );
});
