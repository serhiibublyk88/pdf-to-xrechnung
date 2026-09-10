export const TEXT_EXTRACTOR = Symbol('TEXT_EXTRACTOR');

export class RetryableTextExtractionError extends Error {}

export class PdfResourceLimitError extends Error {}

export class TextTooLongError extends Error {
  constructor(
    readonly charCount: number,
    readonly limit: number,
  ) {
    super('PDF text exceeds the configured character limit');
  }
}

export class TooManyPagesError extends Error {
  constructor(
    readonly pageCount: number,
    readonly limit: number,
  ) {
    super(`PDF has ${pageCount} pages, exceeding the limit of ${limit}`);
  }
}

export interface PageText {
  pageNumber: number;
  charCount: number;
}

export interface ExtractedText {
  text: string;
  pageCount: number;
  charCount: number;
  pages: PageText[];
}

export interface TextExtractor {
  extract(pdf: Buffer): Promise<ExtractedText>;
}

export function assemblePageText(
  pages: Array<{ pageNumber: number; text: string }>,
): { text: string; charCount: number } {
  return {
    text: pages
      .map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`)
      .join('\n\n'),
    charCount: pages.reduce((total, page) => total + page.text.length, 0),
  };
}
