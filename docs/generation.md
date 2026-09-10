# XRechnung generation and conformance

## 1. Why this layer exists

[`validation.md`](validation.md) establishes that `GENERATING` means no implemented
ERROR-level schema or deterministic rule failed. Two steps remain before the invoice can
become a conformant XRechnung document:

- The raw extraction schema ([`extraction.md`](extraction.md)) stores what an LLM can read
  from a PDF: printed unit text, a VAT percentage, and free-text exemption reasons. UBL
  needs coded values (UNECE Rec. 20 unit codes, EN 16931 VAT category letters, ISO 6523
  electronic-address schemes) that the raw schema does not carry.
- KoSIT must accept the generated UBL document before the invoice can reach `READY`.

This layer maps extracted data to `@e-invoice-eu/core`'s `Invoice` format and submits the
result to KoSIT.

## 2. Pipeline position and state transitions

```text
GENERATING → GENERATING_DOCUMENT → NEEDS_REVIEW   mapping or KoSIT rejected deterministically
GENERATING → GENERATING_DOCUMENT → READY          KoSIT accepted the document
```

After atomically moving validation to `GENERATING`, `ValidationProcessor` enqueues the
generation job. `GenerationQueue` and `GenerationReconciler` use the shared
`PipelineStageQueue` and `requeueStrandedInvoices` mechanics described in
[`architecture.md`](architecture.md). A worker claims `GENERATING` as
`GENERATING_DOCUMENT` before reading input. The reconciler scans both states after a crash.
Only the claimed state may write findings or XML, so duplicate or stale workers lose the
compare-and-swap first.

`InvoiceStateMachine` provides two atomic transitions from `GENERATING_DOCUMENT`:

- **`rejectGeneration`:** used when mapping rejects the invoice. It replaces this
  invoice's `mapping.` findings while preserving validation findings. A repeated rejection
  remains idempotent, and no `GeneratedDocument` row is written.
- **`completeGeneration`:** used after XML is submitted to KoSIT. It creates the
  `GeneratedDocument` row and
  transitions to `READY` or `NEEDS_REVIEW` in the same transaction, mirroring
  `completeValidation`'s CAS-then-write-child-rows shape for a different child table
  (`apps/api/prisma/schema.prisma`'s `GeneratedDocument`, not `ValidationResult`).

`completeValidation` is available only in `VALIDATING` and replaces the whole finding set
because every validation rule runs again. The generation stage does not reuse that
operation because it does not recompute the
validation rules and could not restore what it deleted.

Mapping rejections use `ValidationResult` so the review UI reads one findings table.
The `mapping.` prefix lets validation and generation update their own rows without
overwriting each other. See [`validation.md`](validation.md) §2 for severity and routing.

## 3. Mapping matrix

[`extraction.md`](extraction.md) §3.1 classifies every UBL target field as extracted, fixed,
derived, or fallback. `apps/api/src/generation/xrechnung-mapper.ts`
implements that matrix. Deviations from a naive one-field-to-one-field mapping:

| Target                                                                                                   | Rule                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cbc:InvoiceTypeCode`                                                                                    | fixed `"380"` (the current scope issues standard invoices)                                                                                                                                                  |
| `cac:Delivery/cbc:ActualDeliveryDate` (BT-72)                                                            | mapped when the invoice printed a delivery date; omitted otherwise. KoSIT reports BR-DE-TMP-32 as information when it is absent                                                                             |
| `cac:PayeeFinancialAccount/cac:FinancialInstitutionBranch/cbc:ID` (BT-86)                                | the seller BIC, mapped only alongside an IBAN, since it identifies that account's institution                                                                                                               |
| `cbc:PaymentMeansCode`                                                                                   | derived `"58"` when `sellerIban` is present; otherwise `cac:PaymentMeans` is omitted                                                                                                                        |
| Line/VAT-breakdown tax category (`cbc:ID`)                                                               | driven by the reviewer-selected `VatBreakdown.category` (§5.2); no category and a positive rate maps to `S` at any percentage. Germany's reduced 7% rate is also `S` with `Percent: "7"`                    |
| Zero VAT rate with no category                                                                           | rejected because the reviewer must select the applicable category (§5.2)                                                                                                                                    |
| Non-zero VAT rate with a non-`S` category, or a zero rate whose category needs a reason it does not have | rejected (§5.2)                                                                                                                                                                                             |
| Line unit code (`cbc:InvoicedQuantity@unitCode`)                                                         | looked up from the printed-unit table in §4; a `null` unit is omitted, while an unrecognized printed unit is rejected                                                                                       |
| Seller tax scheme                                                                                        | mapped from `seller.vatId` as `cac:TaxScheme/cbc:ID = 'VAT'`; a seller with only a Steuernummer is rejected because its fiscal-code scheme has not been verified (§5)                                       |
| Buyer tax scheme                                                                                         | mapped from `buyer.vatId` when present; EN 16931 does not require it for ordinary B2B invoices                                                                                                              |
| Currency, both parties' country codes, both parties' electronic-address schemes                          | country checked against `@e-invoice-eu/core`'s closed list; currency and electronic-address schemes checked against the supported generator and KoSIT intersection; values outside those lists are rejected |
| Party street                                                                                             | included when present; this matches [`validation.md`](validation.md) §5, where `mandatory.party_street` is a `WARNING`                                                                                      |
| No line items or no VAT breakdown entries                                                                | rejected with a finding for the review UI; `plausible.line_count` and `mandatory.vat_breakdown` normally stop these cases earlier, but the mapper checks them independently                                 |

All monetary fields are reformatted to exactly two decimal places from the
already-validated exact-decimal representation in
[`decimal.ts`](../apps/api/src/money/decimal.ts). Quantity and unit price pass through as
printed, following [`extraction.md`](extraction.md) §4. A monetary value with more than two
decimal places is rejected with `mapping.amount_precision`. `cbc:Percent` also passes through as printed
(`"19"`, not `"19.00"`); KoSIT accepts either form.

## 4. Unit code lookup

UNECE Recommendation 20 has hundreds of codes. Defaulting an unrecognized unit to `C62`
("piece"), for example, would change the meaning of a service line. `UNIT_CODES` is a
small, case-insensitive table of unit text used by current fixtures:
`Stück`/`Stk`/`St` → `C62`, `Std`/`Stunde`/`h`/`hour`/`hours` → `HUR`, `Tag(e)` → `DAY`,
`kg`, `g`, `l`, `m`, `m²`/`qm`, `m³`/`cbm`. Anything else produces a `mapping.line_unit`
finding and routes to review. Add a new mapping when an invoice or fixture demonstrates
the need.

### 4.1 Code lists

`UNIT_CODES` and `ELECTRONIC_ADDRESS_SCHEMES` live in `packages/contracts/src/units.ts`
and `packages/contracts/src/electronic-address-schemes.ts` in the
`@pdf-to-xrechnung/contracts` workspace package, so the API and correction form use the
same closed options. `UN_ECE_UNIT_CODES` is a literal tuple whose values are checked at
compile time against `@e-invoice-eu/core`'s `InvoicedQuantityUnitOfMeasure` type; a library
upgrade that drops one fails the build.

Electronic-address schemes and currencies use the intersection accepted by both the
installed generator and the pinned KoSIT target. The generator accepts values that KoSIT
rejects, including scheme `0245` under `BR-CL-25` and currency `STN` under `BR-CL-04`, so
those values are excluded. Conversely, KoSIT accepts some schemes that the generator
rejects. The intersection must be probed again whenever either
dependency changes.

The review form also shares the server's IBAN, VAT-ID, Leitweg-ID, BIC, email, phone, and
German-postal-code checks. Browser feedback remains non-blocking; the server makes the
final decision.

## 5. Mapping rejections

### 5.1 Seller tax identifier

A seller identified only by Steuernummer cannot reach `READY` automatically. The
corresponding UBL `PartyTaxScheme` binding has not been verified against KoSIT, so the
mapper returns a field-level rejection instead of choosing an unverified scheme.

### 5.2 VAT category

`resolveVatCategory` (`xrechnung-mapper.ts`) takes the rate and the reviewer-chosen
`category` together. An omitted category is accepted only for a positive rate, where it
maps to `S`; every zero-rate case requires an explicit reviewer choice.

| Category (offered)                    | Condition on rate | Emitted `cbc:ID` | Exemption reason                                          | Other requirement                                                        |
| ------------------------------------- | ----------------- | ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `S` (standard, or no category chosen) | must be `> 0`     | `S`              | none                                                      | —                                                                        |
| `AE` (reverse charge)                 | must be `0`       | `AE`             | implied `VATEX-EU-AE`                                     | buyer VAT ID (`BR-AE-02`)                                                |
| `K` (intra-community supply)          | must be `0`       | `K`              | implied `VATEX-EU-IC`                                     | seller and buyer VAT IDs (`BR-IC-02`); a deliver-to country (`BR-IC-12`) |
| `G` (export outside the EU)           | must be `0`       | `G`              | implied `VATEX-EU-G`                                      | —                                                                        |
| `E` (§ 4 UStG exemption)              | must be `0`       | `E`              | the reviewer's own free-text `exemptionReason` — required | —                                                                        |
| `Z` (zero rated)                      | must be `0`       | `Z`              | none                                                      | —                                                                        |

A rate/category mismatch is a mapping rejection (`mapping.vat_breakdown_category` for the
breakdown row, `mapping.line_vat_category` for a line item), the same finding shape every
other mapping rejection uses.

For category `K`, the buyer's country is also used as the delivery country.
`resolveDelivery` adds `cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country` from the
verified `buyer.countryCode` whenever any breakdown row uses `K`. The raw schema has no
separate delivery address, so a category-`K` invoice delivered to another country is
outside the supported boundary.

Four UNCL5305 codes are not offered. `L` (Canary Islands), `M`
(Ceuta/Melilla), and `B` (Italian split payment) are outside the supported German invoice
cases. `O` (not subject to VAT) conflicts with `BR-O-02`, which forbids a seller, buyer, or
seller-tax-representative VAT identifier anywhere
on the invoice once any line uses it, which conflicts with this project's
`mandatory.seller_tax_id`/`mapping.seller_tax_id` boundary. The pipeline does not map an
alternative seller identity that would make `O` usable without contradiction.

Line items derive their category from the VAT breakdown. A line's rate is matched against
the VAT-breakdown rows sharing that rate. When exactly one distinct category matches, the
line item's `cac:ClassifiedTaxCategory` uses it. Two breakdown rows at the same rate with different categories make the line
ambiguous and produce a `mapping.line_vat_category` finding. `LINEVATINFORMATION`, the
line-level type accepted by the generator, has no exemption-reason fields. The implied or
free-text reason is emitted only at VAT-breakdown level (`cac:TaxTotal/cac:TaxSubtotal`),
never per line.

Every offered category has been verified against the real KoSIT container. Those probes
also establish `AE`'s buyer-VAT-ID requirement, `K`'s deliver-to-country requirement, and
the absence of another local requirement for `G`, `E`, and `Z` beyond the table.

The extraction prompt does not request `category`; see [`api-contract.md`](api-contract.md)
§6. `exemptionReason` remains part of the extraction contract because it is printed on the
invoice. The mapper derives machine-readable exemption codes from the selected category.

## 6. KoSIT submission

`KositClient` (`apps/api/src/generation/kosit-client.ts`) POSTs the generated XML to
`KOSIT_VALIDATOR_URL/?type=xml`. `parseKositReport` (`kosit-report.ts`) reads the response
with `fast-xml-parser`: the `valid="true"/"false"` attribute on the report's root
`<rep:report>` element and every `<rep:message>` the validator emitted, with its `code`,
`level`, and text.

`kosit-report.spec.ts` covers two parser requirements using reports captured from the
running container:

- Well-formedness is checked first because `fast-xml-parser` accepts some malformed input.
  A truncated body must be classified as retryable, not parsed as `valid="false"`.
- Only `<rep:message>` elements count. The report's scenario section carries
  `<s:customLevel level="error">` configuration entries and embeds a full XHTML rendering
  of itself, so the parser stops at `rep:assessment` and matches on the element rather
  than on any `level` attribute in the document.

The full report XML is stored in `GeneratedDocument.kositReport`
(`{ xml: "<rep:report ...>" }`), including embedded XHTML. A rejected invoice uses roughly
24 KB during the retention window.

Each rejection message becomes one `ValidationResult` row with rule ID `kosit.<code>`. If
the code is absent, it falls back to the message ID and then `unspecified`. Severity is
mapped from the message level: `error → ERROR`,
`warning → WARNING`, `information → INFO`. A rejection with no rule produces one
`kosit.unspecified` ERROR row so it remains visible in review. An accepted document writes
none, which also clears a previous cycle's rows: `completeGeneration` replaces exactly the
`kosit.` rows in the same transaction that writes the document, so an earlier validation
pass's findings and the `mapping.` rows are untouched.

The report's `xpathLocation` is not copied into the row. It addresses a node
of the generated XML, not a field of the correction form, and `ValidationResult.field` is
what the review UI binds to an input; the xpath survives in `kositReport` for operator
use.

Transport failures and responses without a recognizable report root become
`RetryableKositError`. BullMQ retries with backoff and moves the job to the DLQ on
exhaustion. HTTP status does not classify the outcome. The running validator answers a
rejection with a non-2xx status (406 for a business-rule violation, 422 for malformed XML)
and a complete `<rep:report ... valid="false">`. A parseable `valid="false"` routes to
`NEEDS_REVIEW`; a parseable `valid="true"` routes to `READY`.

A mapped `Invoice` object rejected by `@e-invoice-eu/core`'s AJV schema becomes a
deterministic `mapping.generation_failed` finding. The TypeScript narrowing in §3 and §4
makes this unlikely, and retrying the same input would not change the result.

Only a thrown value carrying an `errors` array counts as an AJV schema rejection. This is
the runtime shape of AJV's `ValidationError`, verified against the installed library.
Anything else the generator throws is re-thrown untouched. It then follows the normal
retry and dead-letter path instead of being recorded as a content problem.

## 7. Download endpoint

`GET /invoices/:id/document` is owner-scoped like `GET /invoices/:id`. It serves
`GeneratedDocument.xml` only while the invoice is `READY`. For a `NEEDS_REVIEW` invoice,
the UI shows the `kosit.` or `mapping.` findings written in §6 and §2.

A lifecycle produces at most one current `GeneratedDocument`: `completeGeneration` runs
only once per generation claim and expiry-reuse deletes child rows before a new lifecycle
starts. A human correction deletes the preceding document in the same transaction as
the correction, so a stored document is never shown as the result of a later revision.

## 8. Testing

- `xrechnung-mapper.spec.ts` covers the complete mapping and every rejection rule without
  I/O, including collection of independent problems in one pass.
- `kosit-report.spec.ts` uses accepted and rejected reports captured from the real KoSIT
  container. It also checks truncated XML, HTML, and plain text. `kosit-client.spec.ts`
  covers the retryable and deterministic branches at the HTTP boundary.
- `generation.processor.spec.ts` covers stale work, exhausted retries, lost lifecycle
  claims, mapping and KoSIT outcomes, and both generator failure classes. Its successful
  path runs the installed `@e-invoice-eu/core` generator.
- `apps/api/test/generation.e2e-spec.ts` recovers a stranded `GENERATING` invoice, runs it
  through the real KoSIT container, reaches `READY`, and downloads the XML over HTTP.
  Additional cases cover mapping findings, preservation of validation findings, KoSIT
  rejection details, delivery date and BIC output, VAT ID normalisation, and owner-scoped
  download denial.

## 9. Known limits

- Add a printed unit only after an invoice or fixture demonstrates the need; an unknown
  unit routes to review instead of defaulting to `C62`.
- Steuernummer-only sellers remain blocked until their UBL tax-scheme binding has been
  measured against KoSIT.
- Category-`K` generation assumes the delivery country equals the buyer country.
- Credit notes, non-`380` invoice types, and document-level `AllowanceCharge` structures
  are outside the current product scope.
