export interface RecognisedText {
  text: string;
  meanConfidence: number;
}

interface TsvRow {
  level: number;
  pageNumber: number;
  blockNumber: number;
  paragraphNumber: number;
  lineNumber: number;
  confidence: number;
  text: string;
}

const REQUIRED_COLUMNS = [
  'level',
  'page_num',
  'block_num',
  'par_num',
  'line_num',
  'conf',
  'text',
] as const;

type ColumnName = (typeof REQUIRED_COLUMNS)[number];
type ColumnIndexes = Record<ColumnName, number>;

function numericField(value: string | undefined, field: string): number {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) {
    throw new Error(`Tesseract TSV has an invalid ${field} value`);
  }
  return parsed;
}

function parseHeader(header: string | undefined): ColumnIndexes {
  if (!header) {
    // A zero-byte result is transient engine failure, not a blank page.
    throw new Error('Tesseract TSV output is empty');
  }
  const columns = header.split('\t');
  const indexes: ColumnIndexes = {
    level: columns.indexOf('level'),
    page_num: columns.indexOf('page_num'),
    block_num: columns.indexOf('block_num'),
    par_num: columns.indexOf('par_num'),
    line_num: columns.indexOf('line_num'),
    conf: columns.indexOf('conf'),
    text: columns.indexOf('text'),
  };
  for (const column of REQUIRED_COLUMNS) {
    if (indexes[column] < 0) {
      throw new Error(`Tesseract TSV header is missing ${column}`);
    }
  }
  if (indexes.text !== columns.length - 1) {
    throw new Error('Tesseract TSV header does not end with the text column');
  }
  return indexes;
}

function parseRow(line: string, indexes: ColumnIndexes): TsvRow {
  const columns = line.split('\t');
  if (columns.length <= Math.max(...Object.values(indexes))) {
    throw new Error('Tesseract TSV row has fewer columns than its header');
  }

  return {
    level: numericField(columns[indexes.level], 'level'),
    pageNumber: numericField(columns[indexes.page_num], 'page number'),
    blockNumber: numericField(columns[indexes.block_num], 'block number'),
    paragraphNumber: numericField(columns[indexes.par_num], 'paragraph number'),
    lineNumber: numericField(columns[indexes.line_num], 'line number'),
    confidence: numericField(columns[indexes.conf], 'confidence'),
    text: columns.slice(indexes.text).join('\t'),
  };
}

function lineKey(row: TsvRow): string {
  return `${row.pageNumber}:${row.blockNumber}:${row.paragraphNumber}:${row.lineNumber}`;
}

export function parseTesseractTsv(tsv: string): RecognisedText {
  const rows = tsv.split(/\r?\n/);
  const indexes = parseHeader(rows.shift());

  const wordsByLine = new Map<string, string[]>();
  const lines: TsvRow[] = [];
  let confidenceTotal = 0;
  let wordCount = 0;

  for (const rawRow of rows) {
    if (rawRow === '') continue;
    const row = parseRow(rawRow, indexes);
    if (row.level === 4) {
      lines.push(row);
      continue;
    }
    if (row.level !== 5 || row.text.trim() === '') continue;

    const key = lineKey(row);
    const words = wordsByLine.get(key) ?? [];
    words.push(row.text);
    wordsByLine.set(key, words);
    confidenceTotal += row.confidence;
    wordCount += 1;
  }

  return {
    text: lines
      .map((line) => wordsByLine.get(lineKey(line))?.join(' ') ?? '')
      .filter((line) => line !== '')
      .join('\n'),
    meanConfidence: wordCount === 0 ? 0 : confidenceTotal / wordCount,
  };
}
