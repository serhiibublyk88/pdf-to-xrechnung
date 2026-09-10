import { buildValidRawExtractedInvoiceData } from '../../data-extraction/raw-extracted-invoice.fixture';
import { validateExtractedInvoice } from '../invoice-validator';
import { ARITHMETIC_RULE_IDS } from './arithmetic';
import { COMPLETENESS_RULE_IDS } from './completeness';
import { FORMAT_RULE_IDS } from './formats';
import { PLAUSIBILITY_RULE_IDS } from './plausibility';

const SCHEMA_EXTRACTED_DATA_RULE = 'schema.extracted_data';

const EXPECTED_RULE_CATALOGUE = [
  'arithmetic.gross',
  'arithmetic.line_net',
  'arithmetic.line_sum',
  'arithmetic.vat_amount',
  'arithmetic.vat_base_sum',
  'arithmetic.vat_total',
  'format.bic',
  'format.calendar_date',
  'format.country_code',
  'format.currency',
  'format.email',
  'format.iban_checksum',
  'format.leitweg_id_checksum',
  'format.monetary_precision',
  'format.phone',
  'format.postal_code_de',
  'format.vat_id_checksum',
  'format.vat_id_prefix',
  'format.vat_id_syntax',
  'mandatory.buyer_identity',
  'mandatory.buyer_reference',
  'mandatory.currency',
  'mandatory.delivery_date',
  'mandatory.electronic_address',
  'mandatory.invoice_number',
  'mandatory.issue_date',
  'mandatory.line_amounts',
  'mandatory.line_descriptions',
  'mandatory.line_vat_rate_or_exemption',
  'mandatory.monetary_total',
  'mandatory.party_street',
  'mandatory.payment_terms',
  'mandatory.seller_contact',
  'mandatory.seller_iban',
  'mandatory.seller_identity',
  'mandatory.seller_tax_id',
  'mandatory.vat_breakdown',
  'mandatory.vat_category',
  'mandatory.vat_category_buyer_identity',
  'mandatory.vat_category_reason',
  'mandatory.vat_category_seller_vat_id',
  'mandatory.vat_rate_or_exemption',
  'plausible.date_order',
  'plausible.date_range',
  'plausible.line_count',
  'plausible.magnitude',
  'plausible.positive_amounts',
  'plausible.vat_rate',
  'plausible.zero_vat_reason',
  'schema.extracted_data',
].sort();

describe('validation rule catalogue', () => {
  it('is exactly the rule identifiers the validator can emit', () => {
    const actual = [
      ...COMPLETENESS_RULE_IDS,
      ...FORMAT_RULE_IDS,
      ...ARITHMETIC_RULE_IDS,
      ...PLAUSIBILITY_RULE_IDS,
      SCHEMA_EXTRACTED_DATA_RULE,
    ].sort();

    expect(actual).toEqual(EXPECTED_RULE_CATALOGUE);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('never emits a rule identifier outside the catalogue', () => {
    const catalogue = new Set(EXPECTED_RULE_CATALOGUE);
    const invoice = buildValidRawExtractedInvoiceData();
    const findings = validateExtractedInvoice(
      invoice,
      new Date('2026-08-10T00:00:00.000Z'),
    );

    for (const finding of findings) {
      expect(catalogue.has(finding.rule)).toBe(true);
    }
  });
});
