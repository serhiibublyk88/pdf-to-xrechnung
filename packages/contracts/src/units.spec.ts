import {
  UNIT_CODES,
  UNIT_OPTIONS,
  UN_ECE_UNIT_CODES,
  resolveUnitCode,
} from './units';

describe('resolveUnitCode', () => {
  it.each(Object.entries(UNIT_CODES))(
    'resolves synonym %s to its UN/ECE code',
    (synonym, code) => {
      expect(resolveUnitCode(synonym)).toBe(code);
    },
  );

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveUnitCode('  Stk.  ')).toBe('C62');
  });

  it('returns undefined for an unrecognized unit', () => {
    expect(resolveUnitCode('Pausch.')).toBeUndefined();
  });

  it.each(['hour', 'hours'])(
    'resolves the English synonym %s to HUR',
    (synonym) => {
      expect(resolveUnitCode(synonym)).toBe('HUR');
    },
  );
});

describe('UNIT_OPTIONS', () => {
  it('has a value that resolves to a real UN/ECE code for every option', () => {
    for (const option of UNIT_OPTIONS) {
      expect(resolveUnitCode(option.value)).toBeDefined();
    }
  });

  it('covers every distinct code UNIT_CODES can produce', () => {
    const codesFromOptions = new Set(
      UNIT_OPTIONS.map((option) => resolveUnitCode(option.value)),
    );
    const codesFromTable = new Set(Object.values(UNIT_CODES));
    expect(codesFromOptions).toEqual(codesFromTable);
  });
});

const expectedUnitMeaning: Record<string, (typeof UN_ECE_UNIT_CODES)[number]> =
  {
    stück: 'C62',
    stueck: 'C62',
    stk: 'C62',
    'stk.': 'C62',
    st: 'C62',
    'st.': 'C62',
    c62: 'C62',
    std: 'HUR',
    'std.': 'HUR',
    stunde: 'HUR',
    stunden: 'HUR',
    h: 'HUR',
    hour: 'HUR',
    hours: 'HUR',
    tag: 'DAY',
    tage: 'DAY',
    kg: 'KGM',
    g: 'GRM',
    l: 'LTR',
    m: 'MTR',
    'm²': 'MTK',
    qm: 'MTK',
    'm³': 'MTQ',
    cbm: 'MTQ',
  };

const expectedUnitOptionLabels: Record<
  string,
  { labelDe: string; labelEn: string }
> = {
  'Stk.': { labelDe: 'Stück', labelEn: 'Piece' },
  'Std.': { labelDe: 'Stunde', labelEn: 'Hour' },
  Tag: { labelDe: 'Tag', labelEn: 'Day' },
  kg: { labelDe: 'Kilogramm', labelEn: 'Kilogram' },
  g: { labelDe: 'Gramm', labelEn: 'Gram' },
  l: { labelDe: 'Liter', labelEn: 'Liter' },
  m: { labelDe: 'Meter', labelEn: 'Meter' },
  'm²': { labelDe: 'Quadratmeter', labelEn: 'Square meter' },
  'm³': { labelDe: 'Kubikmeter', labelEn: 'Cubic meter' },
};

describe('expected unit semantics (independent of the production table)', () => {
  it.each(Object.entries(expectedUnitMeaning))(
    'means that synonym %s resolves to %s, not a lookalike code',
    (synonym, code) => {
      expect(resolveUnitCode(synonym)).toBe(code);
    },
  );

  it('covers exactly the same synonyms as the production table', () => {
    expect(Object.keys(expectedUnitMeaning).sort()).toEqual(
      Object.keys(UNIT_CODES).sort(),
    );
  });

  it('has no duplicate UN/ECE unit codes', () => {
    expect(new Set(UN_ECE_UNIT_CODES).size).toBe(UN_ECE_UNIT_CODES.length);
  });

  it.each(UNIT_OPTIONS.map((option) => [option.value, option] as const))(
    'gives option %s the expected German and English label',
    (value, option) => {
      const expected = expectedUnitOptionLabels[value];
      expect(expected).toBeDefined();
      expect(option.labelDe).toBe(expected?.labelDe);
      expect(option.labelEn).toBe(expected?.labelEn);
    },
  );
});
