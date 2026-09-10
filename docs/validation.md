# Deterministic validation

## 1. Why this layer exists

The LLM can produce plausible but incorrect values. This layer checks structure,
arithmetic, required fields, and known formats without depending on a particular model.

The same rule can catch errors from different sources:

| Source            | Example                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| LLM hallucination | Model invents a VAT total that conflicts with the printed base and rate |
| OCR misreading    | `1.234,50` read as `1234,50`; `8` read as `B`                           |

An arithmetic check does not need to know whether the error came from OCR or the model.

> `GENERATING` means no implemented ERROR-level schema or deterministic validation
> rule failed. It does not mean the result matches the source PDF. KoSIT conformance
> is required before `READY`; extraction accuracy is measured separately in
> [`evals.md`](evals.md).

## 2. Severity model

| Severity  | Meaning                  | Effect                                          |
| --------- | ------------------------ | ----------------------------------------------- |
| `ERROR`   | The data cannot be right | Blocks XML generation; invoice → `NEEDS_REVIEW` |
| `WARNING` | Suspicious but possible  | Persisted for review; does not block            |
| `INFO`    | Observation              | Recorded only                                   |

Every rule declares its severity; there is no default.

Each evaluated rule produces a `ValidationResult` row with `rule`, `field`, `passed`,
`message`, and where applicable `expected` / `actual`. Results are committed atomically
with the `VALIDATING` outcome, gated by the compare-and-swap predicate
`(id, storageKey, VALIDATING, expiresAt > now)`, so a stale worker cannot leave results
on a reused upload lifecycle. The review UI renders them directly, so messages
are written for a human, not for a log.

## 3. Arithmetic rules

Before any rule below runs, `schema.extracted_data` re-validates the stored raw
extraction against `RawExtractedInvoiceDataSchema`. If it no longer parses, validation
stops with one `ERROR` finding. This protects stored data created under an older schema.

Invoices repeat the same amounts in several forms, which allows these checks:

| Rule                      | Check                                             | Tolerance                  | Severity |
| ------------------------- | ------------------------------------------------- | -------------------------- | -------- |
| `arithmetic.line_net`     | For each line: `quantity × unitPrice = netAmount` | 1 cent, evaluated per line | ERROR    |
| `arithmetic.line_sum`     | `Σ lineItems.netAmount = netTotal`                | 1 cent flat                | ERROR    |
| `arithmetic.vat_base_sum` | `Σ vatBreakdown.base = netTotal`                  | 1 cent flat                | ERROR    |
| `arithmetic.vat_amount`   | For each rate: `base × rate/100 = amount`         | 1 cent, evaluated per rate | ERROR    |
| `arithmetic.vat_total`    | `Σ vatBreakdown.amount = vatTotal`                | 1 cent flat                | ERROR    |
| `arithmetic.gross`        | `netTotal + vatTotal = grossTotal`                | 0 (exact)                  | ERROR    |

### Rounding tolerance

Tolerance follows the operation being checked. It does not grow with the number of lines.

- `line_net` and `vat_amount` each include a multiplication rounded to the nearest cent.
  Every line or VAT rate receives its own one-cent tolerance.
- `line_sum`, `vat_base_sum`, and `vat_total` add amounts that are already rounded. The
  addition uses bigint and introduces no further rounding. A flat one-cent tolerance
  covers the two common issuer policies: rounding each line first or rounding the exact
  sum once.
- `gross` adds two already-rounded totals and therefore uses exact comparison.

Comparisons are done in integer cents, never in floating point:

```
|expected - actual| <= tolerance  → pass
```

The one-cent tolerance covers normal rounding differences without accepting whole-unit
discrepancies.

### Discounts and surcharges

An invoice with a document-level discount can fail `arithmetic.line_sum` legitimately.
The raw schema has no allowance/charge fields, so the current implementation cannot
distinguish that case from a corrupt net total. It therefore keeps the mismatch as an `ERROR` and
routes it to review. EN 16931 allowance/charge modelling is outside the current scope.

### 3.1 Exact decimal arithmetic

[`extraction.md`](extraction.md) §3 stores money and quantities as canonical decimal
strings because floating-point numbers cannot represent decimal values exactly. The validation
domain represents each value as a signed integer coefficient plus a decimal scale.
For example, `10.125` is `{ coefficient: 10125n, scale: 3 }`.

- Parse every decimal string once into that exact representation. Reject a string that
  does not match the canonical `-?\d+(\.\d+)?` shape.
- Printed monetary amounts (`netTotal`, `vatTotal`, `grossTotal`, line `netAmount`, and
  `vatBreakdown[].base/amount`) use at most two decimal places. More precise values are
  rejected, not rounded.
- Unit price and quantity may carry more precision than two decimal places on the
  source invoice. Keep their coefficient and scale unchanged through multiplication;
  converting either operand to cents before multiplication is a data-loss bug.
- Line net amount (`quantity × unitPrice`) is computed at full precision, then
  rounded once to 2 decimal places, half away from zero, to produce the comparable
  minor-unit value. VAT uses the same policy after multiplying the base by the rate.

One decimal utility implements parsing and rounding for every rule. Validation does not use
floating point.

## 4. Format and checksum rules

### VAT ID

German format: `DE` followed by 9 digits.

Checksum algorithm (the 9th digit is the check digit):

```
P = 10
for each of the first 8 digits d:
    M = (d + P) mod 10
    if M == 0: M = 10
    P = (2 * M) mod 11
check = 11 - P
if check == 10: check = 0
```

| Rule                                                                                       | Severity                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------- |
| `format.vat_id_syntax` — a two-character prefix and identifier, with `DE\d{9}` for Germany | ERROR if present and malformed         |
| `format.vat_id_prefix` — prefix is accepted by KoSIT's BR-CO-09 list                       | ERROR if present and invalid           |
| `format.vat_id_checksum` — German check digit valid                                        | ERROR for syntactically valid `DE` IDs |
| `mandatory.seller_tax_id` — at least one present for the seller                            | ERROR (§ 14 UStG)                      |

The implementation follows ISO 7064 MOD 11,10. Tests use known-valid values and mutated
check digits.

Every supplied seller or buyer VAT ID receives the same basic syntax and prefix checks.
The accepted prefixes are the KoSIT BR-CO-09 vocabulary represented by `COUNTRY_CODES`
plus `EL` for Greece; it includes `1A` and `XI`. Foreign national checksum
algorithms are not implemented, so only syntactically valid German IDs receive the German
checksum check. `RawExtractedInvoiceDataSchema` canonicalises `vatId` — stripped of spaces,
uppercased — before durable data reaches a reader, while the shared helpers also normalize
their direct inputs. This preserves a lowercase or printed-with-spaces German ID as `DE`
for the mapper, which writes it into `cbc:CompanyID` and otherwise reaches KoSIT BR-CO-09.

### IBAN

Standard mod-97 check:

```
1. Remove spaces, uppercase
2. Move the first 4 characters to the end
3. Replace each letter with its position + 9  (A=10 ... Z=35)
4. Interpret as an integer; valid iff  n mod 97 == 1
```

The implementation enforces the German length exactly (22) and the general IBAN range
(15–34) for other countries before the checksum.

| Rule                   | Severity                     |
| ---------------------- | ---------------------------- |
| `format.iban_checksum` | ERROR if present and invalid |

### Other formats

| Rule                        | Check                                           | Severity |
| --------------------------- | ----------------------------------------------- | -------- |
| `format.currency`           | XRechnung profile currency code list            | ERROR    |
| `format.country_code`       | XRechnung profile country code list             | WARNING  |
| `format.postal_code_de`     | 5 digits when country is DE                     | WARNING  |
| `format.monetary_precision` | At most 2 decimal places, evaluated per amount  | ERROR    |
| `format.calendar_date`      | Issue/due/delivery date is a real calendar date | ERROR    |

The currency and country checks use the same closed lists as the XRechnung mapper. They are
published from `@pdf-to-xrechnung/contracts` and checked against the installed
`@e-invoice-eu/core` schema. Country codes remain a warning-level plausibility check.

### BIC

ISO 9362 shape only: 4-alphanumeric business-party prefix + 2-alphabetic country code +
2-alphanumeric location code + optional 3-alphanumeric branch code (8 or 11 characters
total). ISO 9362 defines no check digit for a BIC, so unlike IBAN/USt-IdNr this can only
ever be a `WARNING`.

| Rule         | Check                                                                    | Severity |
| ------------ | ------------------------------------------------------------------------ | -------- |
| `format.bic` | matches `[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?` after uppercasing | WARNING  |

### Leitweg-ID (buyer reference)

`buyerReference` (BT-10) is free text in general; a purchase-order reference is just as
valid as a Leitweg-ID. This rule only evaluates once the value already has the
Leitweg-ID shape, so an ordinary reference is not checked against its checksum.

Shape (KoSIT "Leitweg-ID Format-Spezifikation" v2.0.2, 28.07.2021, §2.1):
`<Grobadressierung: 2-12 digits>[-<Feinadressierung: 1-30 alphanumeric>]-<Prüfziffer: 2 digits>`.

Checksum: ISO/IEC 7064:2003 MOD 97-10, the same procedure IBAN uses (§2.4 of the
specification):

```
1. Concatenate Grobadressierung + Feinadressierung, without hyphens
2. Replace each letter with its position + 9  (A=10 ... Z=35)
3. Append "00"
4. Interpret as an integer; check digits = 98 - (n mod 97), zero-padded to 2 digits
```

| Rule                         | Severity                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| `format.leitweg_id_checksum` | WARNING, only evaluated when the value has the Leitweg-ID shape |

The specification's worked example (`04011000-1234512345-06`) is a unit-test case,
alongside no-Feinadressierung, lettered-Feinadressierung, and mutated-check-digit cases.

### Contact email and phone

`contactEmail`/`contactPhone` (BT-41 to BT-43 seller/buyer contact) are plausibility
checks, not RFC-exhaustive parsers. They remain `WARNING` because a value can be schema-valid
text and still be a genuine, unusual real-world address or number.

| Rule           | Check                                                             | Severity |
| -------------- | ----------------------------------------------------------------- | -------- |
| `format.email` | one `@`, at least one character either side, a `.` after the `@`  | WARNING  |
| `format.phone` | only digits, `+`, spaces, parentheses, hyphens; at least 6 digits | WARNING  |

The format and checksum functions live in `@pdf-to-xrechnung/contracts`, so the API rules
and the review form's non-blocking feedback use the same implementation. The server
revalidates every submission and makes the final decision.

## 5. Completeness under § 14 UStG

These rules cover mandatory invoice content under German VAT law. Missing values block XML
generation.

| Field                                          | Rule                              | Severity |
| ---------------------------------------------- | --------------------------------- | -------- |
| Seller name, post code, city, country          | `mandatory.seller_identity`       | ERROR    |
| Buyer name, post code, city, country           | `mandatory.buyer_identity`        | ERROR    |
| Street of either party                         | `mandatory.party_street`          | WARNING  |
| Seller USt-IdNr or Steuernummer                | `mandatory.seller_tax_id`         | ERROR    |
| Invoice date (Rechnungsdatum)                  | `mandatory.issue_date`            | ERROR    |
| Invoice number present and correctly formatted | `mandatory.invoice_number`        | ERROR    |
| Description and quantity of goods/services     | `mandatory.line_descriptions`     | ERROR    |
| Delivery/service date (Leistungsdatum)         | `mandatory.delivery_date`         | WARNING  |
| Net amount per VAT rate                        | `mandatory.vat_breakdown`         | ERROR    |
| VAT rate and amount, or exemption reason       | `mandatory.vat_rate_or_exemption` | ERROR    |

`mandatory.invoice_number` checks presence and format only. § 14 UStG requires the
number to be unique per issuer, but that requires the issuer's invoice history, which this
system does not have. A duplicate would pass this rule.

The "Field" column names what each rule checks, not how many `ValidationFinding` rows it
emits. `mandatory.seller_identity` and `mandatory.buyer_identity` emit one finding per
sub-field (`seller.name`, `seller.postalCode`, `seller.city`, `seller.countryCode`, and
the `buyer.*` equivalents). Separate findings let the review UI bind each failure to its
input. `party_street` and `seller_tax_id` bind to
`<party>.street` and `seller.vatId`. The field-level shape lets the review UI attach each
message to the input that can resolve it.

Small-amount invoices (Kleinbetragsrechnungen, ≤ €250) have reduced tax-content
requirements under § 33 UStDV. The current scope does not apply those reductions. Any
document emitted as XRechnung must satisfy the selected CIUS regardless of invoice size,
so party completeness uses one rule set. See [`PROJECT.md`](PROJECT.md#domain-and-intended-use) for the legal
boundary.

The party-field requirements were measured against the KoSIT
validator (1.6.1, XRechnung 3.0.2, Schematron 2.5.0) by removing one field at a time
from a known-clean document:

| Removed from a party | Result   | Rule                          |
| -------------------- | -------- | ----------------------------- |
| Name                 | rejected | `BR-07` (buyer)               |
| Whole postal address | rejected | `BR-10` (buyer)               |
| City                 | rejected | `BR-DE-3` seller / `-8` buyer |
| Post code            | rejected | `BR-DE-4` seller / `-9` buyer |
| Street               | accepted | —                             |

So `mandatory.seller_identity` / `mandatory.buyer_identity` require name, post code,
city and country as `ERROR`, and the street has its own `mandatory.party_street` rule at
`WARNING`. § 14 UStG's "vollständige Anschrift" may include the street, so the application
still reports its absence. It does not block an otherwise conformant XRechnung.

This mapping is a developer's reading of the statute, not legal advice. The README states
that boundary.

### XRechnung additions

The selected CIUS needs values beyond § 14 UStG:

| Field                                      | Rule                                   | Severity |
| ------------------------------------------ | -------------------------------------- | -------- |
| Document currency                          | `mandatory.currency`                   | ERROR    |
| Buyer reference (Leitweg-ID / order ref)   | `mandatory.buyer_reference`            | ERROR    |
| Payment due date or terms                  | `mandatory.payment_terms`              | ERROR    |
| Seller/buyer electronic address and scheme | `mandatory.electronic_address`         | ERROR    |
| Seller contact name, email, phone          | `mandatory.seller_contact`             | ERROR    |
| Line net amounts                           | `mandatory.line_amounts`               | ERROR    |
| Line VAT rate or exemption reason          | `mandatory.line_vat_rate_or_exemption` | ERROR    |
| Net, VAT, and gross totals                 | `mandatory.monetary_total`             | ERROR    |
| Seller IBAN                                | `mandatory.seller_iban`                | WARNING  |

Unit-code mapping belongs to the UBL mapper, where the value has a real consumer. VAT
category crosses both boundaries: validation gives the reviewer a field-level message, and
the mapper remains the authoritative gate for emitted XML.

Tests against KoSIT confirm that seller contact name, phone, and email are independently
mandatory. `BR-DE-2` requires the group, while `BR-DE-5`, `BR-DE-6`, and `BR-DE-7` require
BT-41, BT-42, and BT-43 respectively.

### 5.1 VAT category

`VatBreakdown.category` is a UNCL5305 code selected by the reviewer. Extraction does not
populate or infer it. Four rules check it before generation:

| Check                                                                                                     | Rule                                    | Severity |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| Category/rate agree: `S` or no category requires a positive rate; every other offered category requires 0 | `mandatory.vat_category`                | ERROR    |
| Free-text reason present for category `E` (§ 4 UStG exemption)                                            | `mandatory.vat_category_reason`         | ERROR    |
| Seller VAT ID present when any group uses `K` (intra-community supply)                                    | `mandatory.vat_category_seller_vat_id`  | ERROR    |
| Buyer VAT ID present when any group uses `AE` (reverse charge) or `K`                                     | `mandatory.vat_category_buyer_identity` | ERROR    |

Real KoSIT probes supply the cross-field requirements: `BR-AE-02` rejects reverse charge
without a buyer VAT or legal-registration identifier, and `BR-IC-02` requires seller and
buyer tax identities for category `K`. This project maps neither a seller tax representative
identifier nor a buyer legal-registration identifier, so its local rules require seller and
buyer VAT IDs. The mapper also supplies `K`'s deliver-to country from the already-mandatory
buyer country (`BR-IC-12`); see [`generation.md`](generation.md) §5.2. Category `O` is not
offered because it conflicts with the supported seller-identification boundary.

## 6. Plausibility rules

These mostly warning-level signals catch OCR damage that arithmetic checks miss.

| Rule                         | Check                                               | Severity |
| ---------------------------- | --------------------------------------------------- | -------- |
| `plausible.vat_rate`         | Rate ∈ {19, 7, 0}; anything else flagged            | WARNING  |
| `plausible.zero_vat_reason`  | Rate 0 requires an exemption reason                 | WARNING  |
| `plausible.date_range`       | Issue date within [today − 10y, today + 1y]         | WARNING  |
| `plausible.date_order`       | `deliveryDate ≤ issueDate`                          | WARNING  |
| `plausible.positive_amounts` | Non-negative totals (credit notes are out of scope) | WARNING  |
| `plausible.line_count`       | ≥ 1 line item                                       | ERROR    |
| `plausible.magnitude`        | Gross total < €10,000,000                           | WARNING  |

The date range and magnitude bounds target OCR errors: a misread digit
typically produces a value that is wrong by an order of magnitude or a decade.

The raw contract has exactly one document-currency field; it cannot express a second
currency to compare. Such a rule would require extending the raw schema and is not
represented as an unconditional passing result.

## 7. Review routing

Severity and routing are separate properties:

- Any rule with severity `ERROR` failed → `NEEDS_REVIEW`, blocks XML generation.
- A failed `WARNING` is persisted for the review UI but does not route to review by itself.

The generation stage may run only when no `ERROR` remains, whether because none occurred
or because a human corrected the data.

## 8. Post-generation validation

After XML generation:

- The document is submitted to the KoSIT validator
- A rejection sends the invoice back to `NEEDS_REVIEW` with the report attached
- The report is stored on `GeneratedDocument.kositReport`

KoSIT, rather than the application alone, decides XRechnung conformance. Project rules
catch common problems earlier and provide field-level findings, but do not replace KoSIT.
[`generation.md`](generation.md) describes mapping and KoSIT failure handling.

## 9. Testing

Arithmetic, checksum, and plausibility rules have passing, failing, and boundary cases.
Presence rules are tested with complete and incomplete invoices.

Integration and e2e cases cover:

- An invoice with a corrupted total → `NEEDS_REVIEW`, with the failed
  arithmetic row persisted
- A stranded `VALIDATING` invoice → requeued by startup reconciliation and its old
  validation rows replaced atomically

The corrupted-total case verifies that invalid arithmetic cannot reach XML generation.

## 10. Known limits

- Document-level allowances and charges are not mapped as EN 16931 `AllowanceCharge`
  structures.
- Credit notes and negative invoice totals are outside the product scope.
- Only German VAT IDs receive a national checksum check; other accepted prefixes receive
  syntax and KoSIT-vocabulary checks.
