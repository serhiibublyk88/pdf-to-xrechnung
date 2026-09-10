// 'O' is real UNCL5305 but unoffered — BR-O-02 conflicts with the mandatory seller VAT ID.
export const VAT_CATEGORY_CODES = ['S', 'AE', 'K', 'G', 'E', 'Z'] as const;
export type VatCategoryCode = (typeof VAT_CATEGORY_CODES)[number];

export const IMPLIED_VAT_EXEMPTION_REASON_CODES = {
  AE: 'VATEX-EU-AE',
  K: 'VATEX-EU-IC',
  G: 'VATEX-EU-G',
} as const satisfies Partial<Record<VatCategoryCode, string>>;

export const VAT_CATEGORIES_REQUIRING_FREE_TEXT_REASON: ReadonlySet<VatCategoryCode> =
  new Set(['E']);
