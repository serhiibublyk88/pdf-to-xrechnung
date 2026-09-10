import type { Invoice } from '@e-invoice-eu/core';
import {
  COUNTRY_CODES,
  CURRENCY_CODES,
  ELECTRONIC_ADDRESS_SCHEMES,
  IMPLIED_VAT_EXEMPTION_REASON_CODES,
  REJECTED_BY_KOSIT_CURRENCY_CODES,
  UN_ECE_UNIT_CODES,
  VAT_CATEGORY_CODES,
} from '@pdf-to-xrechnung/contracts';

type UblInvoice = Invoice['ubl:Invoice'];
type SellerParty = UblInvoice['cac:AccountingSupplierParty']['cac:Party'];
type PostalAddress = SellerParty['cac:PostalAddress'];
type InvoiceLine = UblInvoice['cac:InvoiceLine'][number];
type TaxTotal = UblInvoice['cac:TaxTotal'][number];
type VatSubtotal = NonNullable<TaxTotal['cac:TaxSubtotal']>[number];

export type InvoiceCurrencyCode = UblInvoice['cbc:DocumentCurrencyCode'];
export type SellerCountryCode =
  PostalAddress['cac:Country']['cbc:IdentificationCode'];
export type SellerElectronicAddressIdentificationSchemeIdentifier = NonNullable<
  SellerParty['cbc:EndpointID@schemeID']
>;
export type InvoicedQuantityUnitOfMeasure = NonNullable<
  InvoiceLine['cbc:InvoicedQuantity@unitCode']
>;
type UblVatCategoryCode = VatSubtotal['cac:TaxCategory']['cbc:ID'];
export type UblVatExemptionReasonCode = NonNullable<
  VatSubtotal['cac:TaxCategory']['cbc:TaxExemptionReasonCode']
>;

type AssertNever<T extends never> = T;

/** @knipignore */
export type UnsupportedUnitCode = AssertNever<
  Exclude<(typeof UN_ECE_UNIT_CODES)[number], InvoicedQuantityUnitOfMeasure>
>;

/** @knipignore */
export type UnsupportedCurrencyCode = AssertNever<
  Exclude<
    | (typeof CURRENCY_CODES)[number]
    | (typeof REJECTED_BY_KOSIT_CURRENCY_CODES)[number],
    InvoiceCurrencyCode
  >
>;

/** @knipignore */
export type UnlistedCurrencyCode = AssertNever<
  Exclude<
    InvoiceCurrencyCode,
    | (typeof CURRENCY_CODES)[number]
    | (typeof REJECTED_BY_KOSIT_CURRENCY_CODES)[number]
  >
>;

/** @knipignore */
export type UnsupportedCountryCode = AssertNever<
  Exclude<(typeof COUNTRY_CODES)[number], SellerCountryCode>
>;

/** @knipignore */
export type UnlistedCountryCode = AssertNever<
  Exclude<SellerCountryCode, (typeof COUNTRY_CODES)[number]>
>;

export {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_CURRENCY_CODES,
  SUPPORTED_ELECTRONIC_ADDRESS_SCHEMES,
} from '@pdf-to-xrechnung/contracts';

/** @knipignore */
export type UnsupportedElectronicAddressScheme = AssertNever<
  Exclude<
    (typeof ELECTRONIC_ADDRESS_SCHEMES)[number],
    SellerElectronicAddressIdentificationSchemeIdentifier
  >
>;

/** @knipignore */
export type UnsupportedVatCategoryCode = AssertNever<
  Exclude<(typeof VAT_CATEGORY_CODES)[number], UblVatCategoryCode>
>;

/** @knipignore */
export type UnsupportedVatExemptionReasonCode = AssertNever<
  Exclude<
    (typeof IMPLIED_VAT_EXEMPTION_REASON_CODES)[keyof typeof IMPLIED_VAT_EXEMPTION_REASON_CODES],
    UblVatExemptionReasonCode
  >
>;
