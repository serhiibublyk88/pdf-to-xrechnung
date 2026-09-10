import type { z as MiniZod } from 'zod/mini';
import { VAT_CATEGORY_CODES } from './vat-categories';

export type InvoiceDataZod = Pick<
  typeof MiniZod,
  | '_default'
  | 'array'
  | 'enum'
  | 'int'
  | 'maxLength'
  | 'nullable'
  | 'pipe'
  | 'positive'
  | 'refine'
  | 'regex'
  | 'strictObject'
  | 'string'
  | 'transform'
>;

export const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
export const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
export const currencyCodePattern = /^[A-Z]{3}$/;
export const countryCodePattern = /^[A-Z0-9]{2}$/;
export const MAX_DECIMAL_LENGTH = 40;
export const MAX_TEXT_LENGTH = 1_000;
export const MAX_VAT_ID_LENGTH = 32;
export const MAX_LINE_ITEMS = 300;
export const MAX_VAT_BREAKDOWNS = 30;

function isXmlIllegalCodePoint(codePoint: number): boolean {
  const isControlCode =
    codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f);
  const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  const isNoncharacter = codePoint === 0xfffe || codePoint === 0xffff;
  return isControlCode || isLoneSurrogate || isNoncharacter;
}

function hasXmlIllegalCharacter(value: string): boolean {
  // Code-point iteration preserves valid surrogate pairs while exposing lone surrogates.
  for (const character of value) {
    if (isXmlIllegalCodePoint(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

export function createInvoiceDataSchemas(schema: InvoiceDataZod) {
  const nullableText = (maxLength: number) =>
    schema.nullable(
      schema.string().check(
        schema.maxLength(maxLength),
        schema.refine((value) => !hasXmlIllegalCharacter(value), {
          message: 'Contains characters not allowed in XML 1.0',
        }),
      ),
    );

  const NullableText = nullableText(MAX_TEXT_LENGTH);
  const NullableVatId = schema.pipe(
    nullableText(MAX_VAT_ID_LENGTH),
    schema.transform((value) =>
      value === null ? null : value.replace(/\s+/g, '').toUpperCase(),
    ),
  );
  const DecimalString = schema.nullable(
    schema
      .string()
      .check(
        schema.maxLength(MAX_DECIMAL_LENGTH),
        schema.regex(canonicalDecimalPattern),
      ),
  );
  const IsoDate = schema.nullable(
    schema.string().check(schema.regex(isoDatePattern)),
  );

  const PartySchema = schema.strictObject({
    name: NullableText,
    street: NullableText,
    postalCode: NullableText,
    city: NullableText,
    countryCode: schema.nullable(
      schema.string().check(schema.regex(countryCodePattern)),
    ),
    vatId: NullableVatId,
    taxNumber: NullableText,
    electronicAddress: NullableText,
    electronicAddressScheme: NullableText,
    contactName: NullableText,
    contactEmail: NullableText,
    contactPhone: NullableText,
  });

  const LineItemSchema = schema.strictObject({
    position: schema.nullable(schema.int().check(schema.positive())),
    description: NullableText,
    quantity: DecimalString,
    unit: NullableText,
    unitPrice: DecimalString,
    netAmount: DecimalString,
    vatRate: DecimalString,
    vatExemptionReason: NullableText,
  });

  const VatBreakdownSchema = schema.strictObject({
    rate: DecimalString,
    base: DecimalString,
    amount: DecimalString,
    // Extraction omits category; review owns it and needs a null default.
    category: schema._default(
      schema.nullable(schema.enum(VAT_CATEGORY_CODES)),
      null,
    ),
    exemptionReason: NullableText,
  });

  const RawExtractedInvoiceDataSchema = schema.strictObject({
    invoiceNumber: NullableText,
    issueDate: IsoDate,
    dueDate: IsoDate,
    deliveryDate: IsoDate,
    currency: schema.nullable(
      schema.string().check(schema.regex(currencyCodePattern)),
    ),
    seller: PartySchema,
    buyer: PartySchema,
    sellerIban: NullableText,
    sellerBic: NullableText,
    lineItems: schema
      .array(LineItemSchema)
      .check(schema.maxLength(MAX_LINE_ITEMS)),
    netTotal: DecimalString,
    vatBreakdown: schema
      .array(VatBreakdownSchema)
      .check(schema.maxLength(MAX_VAT_BREAKDOWNS)),
    vatTotal: DecimalString,
    grossTotal: DecimalString,
    paymentTerms: NullableText,
    buyerReference: NullableText,
  });

  return {
    LineItemSchema,
    PartySchema,
    RawExtractedInvoiceDataSchema,
    VatBreakdownSchema,
  };
}
