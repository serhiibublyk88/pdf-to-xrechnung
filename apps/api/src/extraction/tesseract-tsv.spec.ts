import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTesseractTsv } from './tesseract-tsv';

const header =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

describe('parseTesseractTsv', () => {
  it('assembles words into lines and reports their mean confidence', () => {
    const parsed = parseTesseractTsv(
      [
        header,
        '4\t1\t1\t1\t1\t0\t10\t20\t100\t20\t-1\t',
        '5\t1\t1\t1\t1\t1\t10\t20\t50\t20\t96.5\tRechnung',
        '5\t1\t1\t1\t1\t2\t65\t20\t45\t20\t91.5\t123',
        '4\t1\t1\t1\t2\t0\t10\t50\t100\t20\t-1\t',
        '5\t1\t1\t1\t2\t1\t10\t50\t50\t20\t88\tBerlin',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      text: 'Rechnung 123\nBerlin',
      meanConfidence: 92,
    });
  });

  it('returns no text and zero confidence for a blank page', () => {
    expect(parseTesseractTsv(`${header}\n`)).toEqual({
      text: '',
      meanConfidence: 0,
    });
  });

  it('rejects a malformed row', () => {
    expect(() => parseTesseractTsv(`${header}\n5\t1\t1`)).toThrow(
      'fewer columns than its header',
    );
  });

  it('accepts a column inserted before text without changing the recognised text contract', () => {
    const headerWithExtraColumn = header.replace(
      '\ttext',
      '\tscript_confidence\ttext',
    );
    expect(
      parseTesseractTsv(
        [
          headerWithExtraColumn,
          '4\t1\t1\t1\t1\t0\t10\t20\t100\t20\t-1\t0\t',
          '5\t1\t1\t1\t1\t1\t10\t20\t50\t20\t96\t0\tRechnung',
        ].join('\n'),
      ),
    ).toEqual({ text: 'Rechnung', meanConfidence: 96 });
  });

  it('rejects a column added after text instead of silently corrupting every word', () => {
    const headerWithTrailingColumn = `${header}\tscript_confidence`;
    expect(() =>
      parseTesseractTsv(
        [
          headerWithTrailingColumn,
          '4\t1\t1\t1\t1\t0\t10\t20\t100\t20\t-1\t\t0',
          '5\t1\t1\t1\t1\t1\t10\t20\t50\t20\t96\tRechnung\t0',
        ].join('\n'),
      ),
    ).toThrow('does not end with the text column');
  });

  it('treats an empty engine response as malformed TSV', () => {
    expect(() => parseTesseractTsv('')).toThrow(
      'Tesseract TSV output is empty',
    );
  });

  it('parses a real tesseract 5.3.0 TSV without a whitespace-only result line', () => {
    const tsv = readFileSync(
      join(
        __dirname,
        '../../test/fixtures/011-scan-clean-de.tesseract-5.3.0.tsv',
      ),
      'utf8',
    );
    const [header = '', ...rows] = tsv.split(/\r?\n/);
    const textIndex = header.split('\t').indexOf('text');
    const wordConfidences = rows
      .filter((row) => row !== '')
      .map((row) => row.split('\t'))
      .filter(
        (columns) =>
          columns[0] === '5' && (columns[textIndex] ?? '').trim() !== '',
      )
      .map((columns) => Number.parseFloat(columns[10] ?? ''));
    const expectedMeanConfidence =
      wordConfidences.reduce((total, confidence) => total + confidence, 0) /
      wordConfidences.length;

    const parsed = parseTesseractTsv(tsv);

    expect(parsed.text.split('\n').some((line) => line.trim() === '')).toBe(
      false,
    );
    expect(parsed.meanConfidence).toBeCloseTo(expectedMeanConfidence, 10);
    expect(parsed.text).toContain('RE-2026-0001');
  });
});
