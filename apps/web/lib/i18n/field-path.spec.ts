import { describe, expect, it } from 'vitest';
import {
  LineItemSchema,
  PartySchema,
  RawExtractedInvoiceDataSchema,
  VatBreakdownSchema,
} from '@pdf-to-xrechnung/contracts';
import { formatFieldPath } from './field-path';
import { de } from './de';
import { en } from './en';

describe('formatFieldPath', () => {
  it('returns the general-finding label for a null path', () => {
    expect(formatFieldPath(null, de)).toBe(de.review.generalFinding);
  });

  it('resolves a top-level field', () => {
    expect(formatFieldPath('invoiceNumber', de)).toBe(de.fields.invoiceNumber);
  });

  it('resolves a bare party path', () => {
    expect(formatFieldPath('seller', de)).toBe(de.fields.seller);
    expect(formatFieldPath('buyer', de)).toBe(de.fields.buyer);
  });

  it('composes a party sub-field label', () => {
    expect(formatFieldPath('seller.vatId', de)).toBe(
      `${de.fields.seller} · ${de.party.vatId}`,
    );
  });

  it('composes a line-item sub-field label with a one-based position', () => {
    expect(formatFieldPath('lineItems[3].netAmount', de)).toBe(
      `${de.review.positionLabel(4)} · ${de.lineItem.netAmount}`,
    );
  });

  it('falls back to the bare position label for an indexed line item with no sub-field', () => {
    expect(formatFieldPath('lineItems[0]', de)).toBe(
      de.review.positionLabel(1),
    );
  });

  it('composes a VAT breakdown sub-field label', () => {
    expect(formatFieldPath('vatBreakdown[0].rate', de)).toBe(
      `${de.review.vatGroupLabel(1)} · ${de.vatBreakdownField.rate}`,
    );
  });

  it('resolves the totals collection', () => {
    expect(formatFieldPath('totals', de)).toBe(de.review.groups.totals);
  });

  it('labels every shared schema field in both locales', () => {
    for (const dictionary of [de, en]) {
      for (const field of Object.keys(RawExtractedInvoiceDataSchema.shape)) {
        expect(formatFieldPath(field, dictionary)).not.toBe(field);
      }
      for (const field of Object.keys(PartySchema.shape)) {
        const path = `seller.${field}`;
        expect(formatFieldPath(path, dictionary)).not.toBe(path);
      }
      for (const field of Object.keys(LineItemSchema.shape)) {
        const path = `lineItems[0].${field}`;
        expect(formatFieldPath(path, dictionary)).not.toBe(path);
      }
      for (const field of Object.keys(VatBreakdownSchema.shape)) {
        const path = `vatBreakdown[0].${field}`;
        expect(formatFieldPath(path, dictionary)).not.toBe(path);
      }
    }
  });
});
