import { COUNTRY_CODES } from './country-codes';

const VAT_ID_PREFIXES: ReadonlySet<string> = new Set([...COUNTRY_CODES, 'EL']);

function normalizeVatId(vatId: string): string {
  return vatId.replace(/\s+/g, '').toUpperCase();
}

export function vatIdHasValidSyntax(vatId: string): boolean {
  const normalized = normalizeVatId(vatId);
  return normalized.startsWith('DE')
    ? /^DE\d{9}$/.test(normalized)
    : /^[A-Z0-9]{2}[A-Z0-9]+$/.test(normalized);
}

export function vatIdHasAllowedPrefix(vatId: string): boolean {
  return VAT_ID_PREFIXES.has(normalizeVatId(vatId).slice(0, 2));
}
