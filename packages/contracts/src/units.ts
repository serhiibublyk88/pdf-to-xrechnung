export const UN_ECE_UNIT_CODES = [
  'C62',
  'HUR',
  'DAY',
  'KGM',
  'GRM',
  'LTR',
  'MTR',
  'MTK',
  'MTQ',
] as const;

export const UNIT_CODES: Readonly<
  Record<string, (typeof UN_ECE_UNIT_CODES)[number]>
> = {
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

export function resolveUnitCode(
  unit: string,
): (typeof UN_ECE_UNIT_CODES)[number] | undefined {
  return UNIT_CODES[unit.trim().toLowerCase()];
}

export const UNIT_OPTIONS: ReadonlyArray<{
  value: string;
  labelDe: string;
  labelEn: string;
}> = [
  { value: 'Stk.', labelDe: 'Stück', labelEn: 'Piece' },
  { value: 'Std.', labelDe: 'Stunde', labelEn: 'Hour' },
  { value: 'Tag', labelDe: 'Tag', labelEn: 'Day' },
  { value: 'kg', labelDe: 'Kilogramm', labelEn: 'Kilogram' },
  { value: 'g', labelDe: 'Gramm', labelEn: 'Gram' },
  { value: 'l', labelDe: 'Liter', labelEn: 'Liter' },
  { value: 'm', labelDe: 'Meter', labelEn: 'Meter' },
  { value: 'm²', labelDe: 'Quadratmeter', labelEn: 'Square meter' },
  { value: 'm³', labelDe: 'Kubikmeter', labelEn: 'Cubic meter' },
];
