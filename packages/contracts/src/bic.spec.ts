import { bicHasValidFormat } from './bic';

describe('bicHasValidFormat', () => {
  it('accepts a known-valid 8-character BIC', () => {
    expect(bicHasValidFormat('DEUTDEFF')).toBe(true);
  });

  it('accepts a known-valid 11-character BIC with a branch code', () => {
    expect(bicHasValidFormat('COBADEFFXXX')).toBe(true);
  });

  it('accepts lowercase input', () => {
    expect(bicHasValidFormat('deutdeff')).toBe(true);
  });

  it('rejects 9 or 10 characters', () => {
    expect(bicHasValidFormat('DEUTDEFFX')).toBe(false);
    expect(bicHasValidFormat('DEUTDEFFXX')).toBe(false);
  });

  it('rejects 7 characters', () => {
    expect(bicHasValidFormat('DEUTDEF')).toBe(false);
  });

  it('rejects 12 characters', () => {
    expect(bicHasValidFormat('COBADEFFXXXX')).toBe(false);
  });

  it('accepts an alphanumeric business-party prefix (ISO 9362 4an)', () => {
    expect(bicHasValidFormat('A1BCDE22')).toBe(true);
  });

  it('rejects a digit in the country-code positions', () => {
    expect(bicHasValidFormat('DEUT0EFF')).toBe(false);
  });

  it('rejects punctuation or whitespace inside the location code', () => {
    expect(bicHasValidFormat('DEUTDE-F')).toBe(false);
    expect(bicHasValidFormat('DEUTDE F')).toBe(false);
  });

  it('rejects punctuation or whitespace inside the branch code', () => {
    expect(bicHasValidFormat('COBADEFFX-X')).toBe(false);
    expect(bicHasValidFormat('COBADEFFX X')).toBe(false);
  });

  it('accepts outer whitespace that is trimmed before matching', () => {
    expect(bicHasValidFormat('  DEUTDEFF  ')).toBe(true);
  });
});
