import {
  bicHasValidFormat,
  canonicalDecimalPattern,
  countryCodePattern,
  currencyCodePattern,
  ibanHasValidChecksum,
  isGermanPostalCode,
  isoDatePattern,
  isPlausibleEmail,
  isPlausiblePhone,
  leitwegIdHasValidChecksum,
  looksLikeLeitwegId,
  vatIdHasAllowedPrefix,
  vatIdHasValidChecksum,
  vatIdHasValidSyntax,
} from '@pdf-to-xrechnung/contracts/review-input';
import {
  type LineItem,
  type RawExtractedInvoiceData,
} from '@pdf-to-xrechnung/contracts';
import { RawExtractedInvoiceDataSchema } from '@/lib/api/schemas';

export type DraftLineItem = Omit<LineItem, 'position'> & {
  position: string | null;
};

export type InvoiceDraft = Omit<RawExtractedInvoiceData, 'lineItems'> & {
  lineItems: DraftLineItem[];
};

export type IssueCode =
  | 'decimal'
  | 'date'
  | 'currency'
  | 'countryCode'
  | 'position'
  | 'thousandsSeparator'
  | 'ibanChecksum'
  | 'vatIdSyntax'
  | 'vatIdPrefix'
  | 'vatIdChecksum'
  | 'germanPostalCode'
  | 'emailFormat'
  | 'phoneFormat'
  | 'bicFormat'
  | 'leitwegIdChecksum'
  | 'vatCategory'
  | 'vatCategoryBuyerVatId'
  | 'vatCategorySellerVatId'
  | 'schemaMismatch';

export const MIRRORED_RULE: Partial<Record<IssueCode, string>> = {
  ibanChecksum: 'format.iban_checksum',
  vatIdSyntax: 'format.vat_id_syntax',
  vatIdPrefix: 'format.vat_id_prefix',
  vatIdChecksum: 'format.vat_id_checksum',
  germanPostalCode: 'format.postal_code_de',
  emailFormat: 'format.email',
  phoneFormat: 'format.phone',
  bicFormat: 'format.bic',
  leitwegIdChecksum: 'format.leitweg_id_checksum',
  vatCategory: 'mandatory.vat_category',
  vatCategoryBuyerVatId: 'mandatory.vat_category_buyer_identity',
  vatCategorySellerVatId: 'mandatory.vat_category_seller_vat_id',
};

export interface FieldIssue {
  path: string;
  code: IssueCode;
  blocking: boolean;
}

export interface DraftChange {
  path: string;
  before: string | null;
  after: string | null;
}

const positiveInteger = /^[1-9]\d*$/;
const monetaryThousands = /^-?\d{1,3}\.\d{3}$/;
const zeroDecimal = /^-?0(?:\.0+)?$/;

const dateFields = ['issueDate', 'dueDate', 'deliveryDate'] as const;
const monetaryTopLevel = ['netTotal', 'vatTotal', 'grossTotal'] as const;
const lineItemMonetary = ['unitPrice', 'netAmount'] as const;
const lineItemRates = ['quantity', 'vatRate'] as const;
const vatBreakdownMonetary = ['base', 'amount'] as const;

export function emptyDraftLineItem(): DraftLineItem {
  return {
    position: null,
    description: null,
    quantity: null,
    unit: null,
    unitPrice: null,
    netAmount: null,
    vatRate: null,
    vatExemptionReason: null,
  };
}

export function toDraft(data: RawExtractedInvoiceData): InvoiceDraft {
  return {
    ...data,
    lineItems: data.lineItems.map((item) => ({
      ...item,
      position: item.position === null ? null : String(item.position),
    })),
  };
}

export function toWire(
  draft: InvoiceDraft,
):
  { ok: true; data: RawExtractedInvoiceData } | { ok: false; paths: string[] } {
  const candidate = {
    ...draft,
    lineItems: draft.lineItems.map((item) => ({
      ...item,
      position: item.position === null ? null : Number(item.position),
    })),
  };

  const parsed = RawExtractedInvoiceDataSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, data: parsed.data };
  const paths = parsed.error.issues.map((issue) =>
    issue.path.reduce<string>(
      (path, segment) =>
        typeof segment === 'number'
          ? `${path}[${segment}]`
          : typeof segment === 'string'
            ? path.length === 0
              ? segment
              : `${path}.${segment}`
            : path,
      '',
    ),
  );
  return { ok: false, paths };
}

function decimalIssues(path: string, value: string | null): FieldIssue[] {
  if (value === null) return [];
  if (!canonicalDecimalPattern.test(value))
    return [{ path, code: 'decimal', blocking: true }];
  return [];
}

function monetaryDecimalIssues(
  path: string,
  value: string | null,
): FieldIssue[] {
  const decimal = decimalIssues(path, value);
  if (decimal.length > 0) return decimal;
  if (value !== null && monetaryThousands.test(value))
    return [{ path, code: 'thousandsSeparator', blocking: false }];
  return [];
}

function patternIssue(
  path: string,
  value: string | null,
  pattern: RegExp,
  code: IssueCode,
): FieldIssue[] {
  if (value === null || pattern.test(value)) return [];
  return [{ path, code, blocking: true }];
}

function ibanChecksumIssue(path: string, value: string | null): FieldIssue[] {
  if (value === null) return [];
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (normalized.length < 15) return [];
  return ibanHasValidChecksum(value)
    ? []
    : [{ path, code: 'ibanChecksum', blocking: false }];
}

function vatIdIssues(path: string, value: string | null): FieldIssue[] {
  if (value === null) return [];

  const issues: FieldIssue[] = [];
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  const syntaxValid = vatIdHasValidSyntax(value);
  if (!syntaxValid) {
    issues.push({ path, code: 'vatIdSyntax', blocking: true });
  }
  if (!vatIdHasAllowedPrefix(value)) {
    issues.push({ path, code: 'vatIdPrefix', blocking: true });
  }
  if (
    syntaxValid &&
    normalized.startsWith('DE') &&
    normalized.length === 11 &&
    !vatIdHasValidChecksum(value)
  ) {
    issues.push({ path, code: 'vatIdChecksum', blocking: true });
  }
  return issues;
}

function germanPostalCodeIssue(
  path: string,
  postalCode: string | null,
  partyCountryCode: string | null,
): FieldIssue[] {
  if (
    partyCountryCode !== 'DE' ||
    postalCode === null ||
    postalCode.length !== 5
  )
    return [];
  return isGermanPostalCode(postalCode)
    ? []
    : [{ path, code: 'germanPostalCode', blocking: false }];
}

function emailFormatIssue(path: string, value: string | null): FieldIssue[] {
  if (value === null) return [];
  const atIndex = value.lastIndexOf('@');
  if (atIndex === -1 || !value.slice(atIndex).includes('.')) return [];
  return isPlausibleEmail(value)
    ? []
    : [{ path, code: 'emailFormat', blocking: false }];
}

function phoneFormatIssue(path: string, value: string | null): FieldIssue[] {
  if (value === null) return [];
  const digitCount = (value.match(/\d/g) ?? []).length;
  if (digitCount < 6) return [];
  return isPlausiblePhone(value)
    ? []
    : [{ path, code: 'phoneFormat', blocking: false }];
}

function bicFormatIssue(path: string, value: string | null): FieldIssue[] {
  if (value === null || value.trim().length < 8) return [];
  return bicHasValidFormat(value)
    ? []
    : [{ path, code: 'bicFormat', blocking: false }];
}

function leitwegIdChecksumIssue(
  path: string,
  value: string | null,
): FieldIssue[] {
  if (value === null || !looksLikeLeitwegId(value)) return [];
  return leitwegIdHasValidChecksum(value)
    ? []
    : [{ path, code: 'leitwegIdChecksum', blocking: false }];
}

function vatCategoryIssue(
  path: string,
  rate: string | null,
  category: InvoiceDraft['vatBreakdown'][number]['category'],
): FieldIssue[] {
  if (rate === null || !canonicalDecimalPattern.test(rate)) return [];
  const isPositive = !rate.startsWith('-') && !zeroDecimal.test(rate);
  const isZero = zeroDecimal.test(rate);
  const matches = category === null || category === 'S' ? isPositive : isZero;
  return matches ? [] : [{ path, code: 'vatCategory', blocking: true }];
}

export function draftIssues(draft: InvoiceDraft): FieldIssue[] {
  const issues: FieldIssue[] = [];

  for (const field of monetaryTopLevel) {
    issues.push(...monetaryDecimalIssues(field, draft[field]));
  }
  for (const field of dateFields) {
    issues.push(...patternIssue(field, draft[field], isoDatePattern, 'date'));
  }
  issues.push(
    ...patternIssue(
      'currency',
      draft.currency,
      currencyCodePattern,
      'currency',
    ),
  );
  issues.push(...ibanChecksumIssue('sellerIban', draft.sellerIban));
  for (const party of ['seller', 'buyer'] as const) {
    issues.push(...vatIdIssues(`${party}.vatId`, draft[party].vatId));
  }
  issues.push(...bicFormatIssue('sellerBic', draft.sellerBic));
  issues.push(
    ...leitwegIdChecksumIssue('buyerReference', draft.buyerReference),
  );
  for (const party of ['seller', 'buyer'] as const) {
    issues.push(
      ...patternIssue(
        `${party}.countryCode`,
        draft[party].countryCode,
        countryCodePattern,
        'countryCode',
      ),
    );
    issues.push(
      ...germanPostalCodeIssue(
        `${party}.postalCode`,
        draft[party].postalCode,
        draft[party].countryCode,
      ),
    );
    issues.push(
      ...emailFormatIssue(`${party}.contactEmail`, draft[party].contactEmail),
    );
    issues.push(
      ...phoneFormatIssue(`${party}.contactPhone`, draft[party].contactPhone),
    );
  }

  draft.lineItems.forEach((item, index) => {
    issues.push(
      ...patternIssue(
        `lineItems[${index}].position`,
        item.position,
        positiveInteger,
        'position',
      ),
    );
    for (const field of lineItemMonetary) {
      issues.push(
        ...monetaryDecimalIssues(`lineItems[${index}].${field}`, item[field]),
      );
    }
    for (const field of lineItemRates) {
      issues.push(
        ...decimalIssues(`lineItems[${index}].${field}`, item[field]),
      );
    }
  });

  draft.vatBreakdown.forEach((entry, index) => {
    for (const field of vatBreakdownMonetary) {
      issues.push(
        ...monetaryDecimalIssues(
          `vatBreakdown[${index}].${field}`,
          entry[field],
        ),
      );
    }
    issues.push(...decimalIssues(`vatBreakdown[${index}].rate`, entry.rate));
    issues.push(
      ...vatCategoryIssue(
        `vatBreakdown[${index}].category`,
        entry.rate,
        entry.category,
      ),
    );
  });

  const hasReverseCharge = draft.vatBreakdown.some(
    (entry) => entry.category === 'AE',
  );
  const hasIntraCommunitySupply = draft.vatBreakdown.some(
    (entry) => entry.category === 'K',
  );
  if (hasIntraCommunitySupply && draft.seller.vatId === null) {
    issues.push({
      path: 'seller.vatId',
      code: 'vatCategorySellerVatId',
      blocking: true,
    });
  }
  if (
    (hasReverseCharge || hasIntraCommunitySupply) &&
    draft.buyer.vatId === null
  ) {
    issues.push({
      path: 'buyer.vatId',
      code: 'vatCategoryBuyerVatId',
      blocking: true,
    });
  }

  return issues;
}

function flatten(draft: InvoiceDraft): Map<string, string | null> {
  const flat = new Map<string, string | null>();

  for (const [key, value] of Object.entries(draft)) {
    if (typeof value === 'string' || value === null) flat.set(key, value);
  }
  for (const party of ['seller', 'buyer'] as const) {
    for (const [key, value] of Object.entries(draft[party])) {
      flat.set(`${party}.${key}`, value);
    }
  }
  draft.lineItems.forEach((item, index) => {
    for (const [key, value] of Object.entries(item)) {
      flat.set(`lineItems[${index}].${key}`, value);
    }
  });
  draft.vatBreakdown.forEach((entry, index) => {
    for (const [key, value] of Object.entries(entry)) {
      flat.set(`vatBreakdown[${index}].${key}`, value);
    }
  });

  return flat;
}

export function diffDraft(
  original: InvoiceDraft,
  current: InvoiceDraft,
): DraftChange[] {
  const before = flatten(original);
  const after = flatten(current);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: DraftChange[] = [];

  for (const path of paths) {
    const previous = before.get(path) ?? null;
    const next = after.get(path) ?? null;
    if (previous !== next)
      changes.push({ path, before: previous, after: next });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
