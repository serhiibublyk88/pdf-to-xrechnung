# HTTP API contract

This document owns the wire format: request and response shapes, status codes, headers, and
enum values. [`architecture.md`](architecture.md) describes the runtime topology and
summarizes the endpoints. The schema behind the payloads lives in
[`../apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) and
[`../packages/contracts/src/invoice-data.ts`](../packages/contracts/src/invoice-data.ts)'s
`RawExtractedInvoiceDataSchema`.

Types are written as TypeScript for precision; the API is plain JSON over HTTP.

## 1. Origin and the browser

The browser never calls the API cross-origin. The Next.js frontend proxies `/api/*`
server-side to the API host, so from the browser's point of view every call below is
same-origin. This is what makes the `SameSite=Lax` session cookie work without a CORS
allowlist or a separate CSRF design. See [`operations.md`](operations.md#configuration).

Paths in this document are API-relative. Through the proxy they are prefixed, e.g.
`POST /sessions` is reached by the browser as `POST /api/sessions`.

## 2. Session and authorization

There is no login. Authorization is an anonymous, server-signed session cookie.

```
invoice_session=<ownerId>.<expiresAtMs>.<hmacSha256Hex>
```

| Property      | Value                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Cookie name   | `invoice_session`                                                                            |
| `ownerId`     | UUID v4, minted by the server                                                                |
| `expiresAtMs` | Unix milliseconds                                                                            |
| Signature     | HMAC-SHA256 over `<ownerId>.<expiresAtMs>`, hex                                              |
| Attributes    | `HttpOnly`, `Path=/`, `SameSite=Lax`, `Max-Age=RETENTION_HOURS×3600`, `Secure` in production |

The cookie is `HttpOnly`, so client JavaScript cannot read it. The browser attaches it
automatically on same-origin requests.

`POST /sessions` issues a cookie and refreshes a still-valid one with a new expiry.
`POST /invoices` also refreshes it on every upload. This keeps the session alive for at
least as long as every invoice owned by it. Without the upload refresh, an invoice created
near the end of a session could outlive its cookie.

Any endpoint below returns `401` when the cookie is absent, malformed, expired or has an
invalid signature. The correct client response to `401` is to call `POST /sessions` and
retry the original request once.

Access to an invoice ends at `min(session expiry, invoice.expiresAt)`.

## 3. Conventions

- Responses carrying invoice data send `Cache-Control: no-store`.
- Timestamps are ISO 8601 strings in JSON (`Date` in the table below means "ISO string on
  the wire").
- Monetary and quantity values are canonical decimal strings (`"1234.56"`), never
  numbers. See §6.
- Dates are `YYYY-MM-DD` strings.
- Unknown or non-owned resources answer `404`, never `403`; ownership is not disclosed.

## 4. Endpoints

### `POST /sessions`

Issues or refreshes the anonymous session cookie.

- **Rate limit:** 30 / minute
- **Request:** no body
- **Response:** `204 No Content`, with `Set-Cookie`
- Idempotent: calling it with a valid cookie returns a refreshed cookie for the **same**
  `ownerId`, not a new identity.

### `POST /invoices`

Uploads a PDF and starts the pipeline.

- **Rate limit:** `RATE_LIMIT_PER_HOUR` (default 20 / hour); uploads use the hourly budget
- **Request:** `multipart/form-data`, single file under field name **`file`**
- **Response:** `202 Accepted`, and a refreshed `Set-Cookie`

```ts
interface UploadAcceptedResult {
  id: string;
  status: InvoiceStatus;
  deduplicated: boolean; // true when this owner already uploaded a byte-identical PDF
}
```

| Code          | Cause                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| `202`         | Accepted (also when `deduplicated: true`)                                |
| `400`         | No file under field `file`; not a PDF; fails the content signature check |
| `401`         | No valid session                                                         |
| `413` / `400` | Larger than `MAX_UPLOAD_MB` (default 10 MB)                              |
| `429`         | Hourly upload budget exhausted                                           |

Before sending, the client checks for MIME type `application/pdf` and a size of at most
10 MB. The server checks both again.

### `GET /invoices`

Lists the caller's live invoices, newest first. Expired invoices are already excluded.

- **Rate limit:** 120 / minute; this is the status-polling endpoint
- **Response:** `200`

```ts
type InvoiceListResponse = InvoiceListItem[];

interface InvoiceListItem {
  id: string;
  originalFilename: string;
  status: InvoiceStatus;
  createdAt: Date;
  expiresAt: Date;
  failure: InvoiceFailure | null; // present when status is FAILED
}
```

`failure` has the same shape as in `GET /invoices/:id`. It is included in each list item so
the UI can identify the failed stage without another request.

### `GET /invoices/:id`

Returns owner-scoped status using PostgreSQL only. This is the endpoint to poll.

- **Rate limit:** 120 / minute
- **Response:** `200`, or `404` when unknown, not owned, or expired

```ts
interface InvoiceStatusResult {
  id: string;
  status: InvoiceStatus;
  sourceType: SourceType;
  pageCount: number | null;
  failure: InvoiceFailure | null; // present when status is FAILED
}
```

### `GET /invoices/:id/source`

Serves the caller's original PDF for display.

- **Rate limit:** 120 / minute
- **Response:** `200`, `Content-Type: application/pdf`,
  `Content-Disposition: inline; filename*=UTF-8''<encoded>`
- `404` when unknown, not owned, expired, or the stored file is gone

Because it is `inline` and same-origin through the proxy, this URL can be used directly as
the `src` of an `<iframe>`/`<object>` and rendered by the browser's built-in PDF viewer.

### `GET /invoices/:id/document`

Serves the generated XRechnung UBL for `READY` invoices.

- **Rate limit:** 120 / minute
- **Response:** `200`, `Content-Type: application/xml`,
  `Content-Disposition: attachment; filename="<name>"`
- `404` when unknown, not owned, expired, or not yet `READY`

### `GET /invoices/:id/review`

The full review payload: fields, findings, dead-letter diagnosis and the correction
capability.

- **Rate limit:** 120 / minute
- **Response:** `200`, or `404`
- **Cost note:** this endpoint fans out to four Redis dead-letter queues. Open it once per
  invoice and poll `GET /invoices/:id` instead.

```ts
interface InvoiceDetail {
  id: string;
  originalFilename: string;
  status: InvoiceStatus;
  sourceType: SourceType;
  pageCount: number | null;
  failure: InvoiceFailure | null;
  expiresAt: Date;
  reviewedAt: Date | null;
  extractedData: RawExtractedInvoiceData | null; // §6
  lifecycleToken: string | null; // §5 — non-null only when NEEDS_REVIEW
  findings: InvoiceFinding[]; // §7
  deadLetter: InvoiceDeadLetter | null;
}

interface InvoiceDeadLetter {
  stage: PipelineStage;
  failedAt: string;
}
```

`extractedData` returns the corrected data once a correction exists, otherwise the model's
latest schema-valid extraction. The API does not expose the original model output after a
correction.

`deadLetter` does not include error text. Raw queue errors are operator diagnostics; the
invoice's `failure` value provides the user-facing reason.

### `InvoiceFailure`

The server sends a closed failure code and numeric parameters only. The client renders
the localized message for its current language; no server-authored failure prose reaches
the UI.

| Code                                | Parameters                                        |
| ----------------------------------- | ------------------------------------------------- |
| `pdf_unreadable`                    | —                                                 |
| `pdf_no_pages`                      | —                                                 |
| `pdf_too_many_pages`                | `pageCount: number`, `limit: number`              |
| `pdf_resource_limit`                | —                                                 |
| `ocr_text_too_sparse`               | `pages: number[]`                                 |
| `ocr_confidence_too_low`            | `lowestPageConfidence: number`, `minimum: number` |
| `text_too_long`                     | `charCount: number`, `limit: number`              |
| `text_extraction_retries_exhausted` | —                                                 |
| `llm_provider_error`                | —                                                 |
| `llm_response_not_json`             | —                                                 |
| `llm_response_schema_mismatch`      | —                                                 |
| `llm_response_truncated`            | —                                                 |
| `llm_no_usable_data`                | —                                                 |
| `data_extraction_retries_exhausted` | —                                                 |
| `validation_retries_exhausted`      | —                                                 |
| `generation_retries_exhausted`      | —                                                 |

Persisted failure data is treated as untrusted input. If a stored code is not in this
closed set, or its params do not match the code's shape, the response still carries the
invoice status but returns `failure: null`; the server emits one generic warning naming
only the technical invoice ID, never the raw stored code, params, or any invoice content.
An old row or rolling deploy must not turn the polling endpoint into a `500`.

### `POST /invoices/:id/review`

Submits a correction and enqueues regeneration.

- **Rate limit:** 30 / minute
- **Response:** `202 Accepted`

```ts
interface ReviewRequest {
  lifecycleToken: string; // exactly /^[0-9a-f]{64}$/, from GET .../review
  correctedData: unknown; // must satisfy RawExtractedInvoiceData — §6
}

type ReviewResult =
  | { status: "NEEDS_REVIEW"; lifecycleToken: string }
  | { status: "GENERATING"; lifecycleToken: null };
```

The returned `status` is the routing decision, recomputed server-side from the
corrected data: `GENERATING` when no failed `ERROR` finding remains, `NEEDS_REVIEW` when
the correction still leaves one. A `202` means the correction was persisted; read `status`
to determine whether generation started.

| Code  | Cause                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| `202` | Correction persisted; see `status` and the replacement `lifecycleToken`                                              |
| `400` | Request shape invalid, or `correctedData` fails the schema                                                           |
| `413` | JSON request body exceeds 5 MiB                                                                                      |
| `401` | No valid session                                                                                                     |
| `404` | Unknown, not owned, or expired                                                                                       |
| `409` | Not in a reviewable state (wrong status), or the lifecycle moved under the caller (stale token / already generating) |

### `POST /invoices/:id/dead-letter/retry`

Retries the invoice's dead-lettered job.

- **Rate limit:** 10 / minute
- **Response:** `204 No Content`

| Code  | Cause                                                                          |
| ----- | ------------------------------------------------------------------------------ |
| `204` | Retry enqueued                                                                 |
| `404` | Unknown, not owned, or expired                                                 |
| `409` | No retriable dead letter, or the retry lost its race (job resumed, entry gone) |

### `DELETE /invoices/:id`

Durably accepts logical deletion of the invoice, its stored PDF and any dead-letter entry.
The operation is irreversible, so the client should ask for confirmation first.

Only a resting lifecycle can be deleted: `NEEDS_REVIEW`, `READY`, or `FAILED`. In every
other status, a worker still holds a claim on the row and the request returns `409`.

- **Rate limit:** 30 / minute
- **Response:** `204 No Content`

| Code  | Cause                                                                        |
| ----- | ---------------------------------------------------------------------------- |
| `204` | Logically deleted; the PDF was erased or is durably queued for retry         |
| `404` | Unknown, not owned, or expired                                               |
| `409` | Still being processed, or the status changed between the read and the delete |

The row and a retry marker are committed together before physical erasure starts. If storage
is unavailable or the process stops afterwards, periodic cleanup retries the marker until the
PDF is gone.

Deleting also releases the content hash, so the same PDF can be uploaded again as a fresh
invoice. This is how a failed invoice is retried.

### `GET /extraction-mode`

Tells the UI whether uploads are extracted by a real provider. It needs no session and
returns no configuration beyond this flag:

```json
{ "demo": true }
```

`demo` is `true` only for `LLM_PROVIDER=mock`, which returns one fixed synthetic invoice for
every upload. The UI then shows a demo-mode notice on every page.

### `GET /health/live` · `GET /health/ready`

Liveness answers if the process can respond, touching no dependency: `200` with
`{ "status": "ok" }`.

Readiness probes PostgreSQL, Redis and the KoSIT validator in parallel and reports each
one on its own, so a failure says which dependency is gone:

```json
{ "status": "ok", "database": "up", "redis": "up", "kosit": "up" }
```

| Code  | Cause                                                                            |
| ----- | -------------------------------------------------------------------------------- |
| `200` | All three reachable                                                              |
| `503` | At least one is `"down"`; the body keeps the same shape with `"status": "error"` |

The KoSIT probe is a bounded `GET` on `KOSIT_VALIDATOR_URL`, and any answer at all counts
as reachable because the validator serves no `200` for a bare request. Neither endpoint is part
of the UI surface.

## 5. The correction capability (`lifecycleToken`)

`GET /invoices/:id/review` returns `lifecycleToken` only when
`status === 'NEEDS_REVIEW'`; otherwise it is `null`. It is an opaque HMAC bound to owner,
invoice ID, `storageKey`,
`expiresAt`, and the current monotonic `reviewVersion`.

Rules for a client:

1. Treat it as opaque. Do not parse, store long-term, or reuse across invoices.
2. Send it back verbatim in `POST /invoices/:id/review`.
3. If the invoice is re-uploaded, or `storageKey` or `expiresAt` otherwise change, the old
   token stops matching and the correction is rejected. A stale browser tab cannot mutate
   a newer lifecycle. Re-fetch the review payload and rebuild the form.
4. `lifecycleToken === null` means the invoice is not correctable right now. The correction
   form must be disabled, not submitted optimistically.

An accepted correction invalidates every earlier token. The signature covers
`id + ownerId + storageKey + expiresAt + reviewVersion`. The accepted correction compares
and increments `reviewVersion` in the same database transaction. Two tabs open on the same
invoice therefore cannot overwrite each other: once tab 1's correction lands, tab 2's
original token stops matching and its submit answers `409`.

An accepted correction returns a replacement `lifecycleToken`, or `null` after the invoice
moves to `GENERATING`. This avoids an extra review request after every `202`. After an error
response, including a `503` from a failed generation enqueue, the invoice may still have
moved. Re-read `GET /invoices/:id/review` before retrying.

## 6. `RawExtractedInvoiceData`

The same shape is used for `extractedData` reads and `correctedData` writes. Objects are
strict: unknown keys are rejected, and a client must send the complete shape instead of a
patch. Every field must be present, although most may be `null`. The exception is
`VatBreakdown.category`, which defaults to `null` when omitted. The extraction prompt does
not request this field.

The structural correction envelope is at most 300 `lineItems` and 30 `vatBreakdown` rows.
Nullable free-text fields accept at most 1,000 characters, except `vatId` at 32; canonical
decimal strings accept at most 40 characters. These schema limits are independent of the
5 MiB JSON transport limit: an over-limit structure receives `400` before it can change the
review lifecycle, while an over-limit body receives `413` before the review handler.

```ts
interface RawExtractedInvoiceData {
  invoiceNumber: string | null;
  issueDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  deliveryDate: string | null; // YYYY-MM-DD
  currency: string | null; // ^[A-Z]{3}$
  seller: Party;
  buyer: Party;
  sellerIban: string | null;
  sellerBic: string | null;
  lineItems: LineItem[];
  netTotal: string | null; // decimal string
  vatBreakdown: VatBreakdown[];
  vatTotal: string | null; // decimal string
  grossTotal: string | null; // decimal string
  paymentTerms: string | null;
  buyerReference: string | null; // Leitweg-ID / order reference
}

interface Party {
  name: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null; // ^[A-Z0-9]{2}$
  vatId: string | null; // USt-IdNr.
  taxNumber: string | null; // Steuernummer
  electronicAddress: string | null;
  electronicAddressScheme: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

interface LineItem {
  position: number | null; // positive integer
  description: string | null;
  quantity: string | null; // decimal string
  unit: string | null;
  unitPrice: string | null; // decimal string
  netAmount: string | null; // decimal string
  vatRate: string | null; // percent as decimal string, e.g. "19"
  vatExemptionReason: string | null;
}

interface VatBreakdown {
  rate: string | null; // decimal string
  base: string | null; // decimal string
  amount: string | null; // decimal string
  category: "S" | "AE" | "K" | "G" | "E" | "Z" | null; // UNCL5305, chosen by the reviewer
  exemptionReason: string | null; // wording printed on the invoice, verbatim
}
```

`category` is the UBL/XRechnung VAT category code (UNCL5305): `S` standard rate, `AE`
reverse charge, `K` intra-community supply, `G` export outside the EU, `E` exempt (§ 4
UStG), `Z` zero rated. It is never populated by extraction — the reviewer picks it — and
it controls how the generator maps `rate` and `exemptionReason`. See
[`generation.md`](generation.md) §5.2 for the supported and unsupported UNCL5305 codes.

### Decimal strings are not display strings

The regex is `^-?(?:0|[1-9]\d*)(?:\.\d+)?$`. That means:

- `"1234.56"` valid · `"1.234,56"` invalid · `"1,234.56"` invalid
- `"0.5"` valid · `".5"` invalid · `"01.5"` invalid
- `1234.56` (a JSON number) invalid; it must be a string

The whole validation and generation layer is built on exact decimal arithmetic. A client
must send canonical decimals back. Localised formatting (`1.234,56 €`) belongs in read-only
display only; an editable field that reformats its value will corrupt the data.

Dates use ISO format. `<input type="date">` submits that format while displaying the value
in the user's locale.

## 7. Findings

```ts
interface InvoiceFinding {
  rule: string; // §7.2 catalogue
  field: string | null; // §7.1 path grammar
  severity: "ERROR" | "WARNING" | "INFO";
  passed: boolean;
  message: string; // English prose, generated server-side
  expected: string | null;
  actual: string | null;
}
```

An invoice goes to `NEEDS_REVIEW` when any finding has
`passed === false && severity === 'ERROR'`. Warnings never block generation.

`message` is English. A localised UI should key its own text off `rule` and interpolate
`field`, `expected` and `actual`, keeping `message` as the fallback for a rule it does not
yet translate.

### 7.1 `field` path grammar

| Shape              | Example                                                  |
| ------------------ | -------------------------------------------------------- |
| Top-level field    | `invoiceNumber`, `grossTotal`, `currency`                |
| Party sub-field    | `seller.vatId`, `buyer.postalCode`, `seller.countryCode` |
| Whole collection   | `lineItems`, `vatBreakdown`, `totals`                    |
| Indexed element    | `lineItems[0]`                                           |
| Indexed sub-field  | `lineItems[3].netAmount`, `lineItems[0].unit`            |
| Not field-specific | `null`                                                   |

Indices are zero-based; a UI showing "Position 4" must add one.

### 7.2 Rule catalogue: 65 application rules

The set is closed and typed: `ValidationRuleCode` in
[`../packages/contracts/src/validation-rule.ts`](../packages/contracts/src/validation-rule.ts),
where it is defined once. Both the API that emits these codes and any TypeScript client
that renders them compile against it. The table below documents what each code means; the
type decides which codes exist.

Severity below is the severity the rule emits when it fails.

**`arithmetic.*`: 6 rules, all ERROR.** Exact-decimal recomputation of invoice amounts.

| Rule                      | Checks                                            |
| ------------------------- | ------------------------------------------------- |
| `arithmetic.line_net`     | quantity × unit price = line net amount           |
| `arithmetic.line_sum`     | Σ line net amounts = net total                    |
| `arithmetic.vat_amount`   | VAT base × rate = VAT amount, per breakdown group |
| `arithmetic.vat_base_sum` | Σ VAT bases = net total                           |
| `arithmetic.vat_total`    | Σ VAT amounts = VAT total                         |
| `arithmetic.gross`        | net total + VAT total = gross total               |

**`format.*`: 13 rules.** Syntax and checksums.

| Rule                         | Severity |
| ---------------------------- | -------- |
| `format.calendar_date`       | ERROR    |
| `format.currency`            | ERROR    |
| `format.iban_checksum`       | ERROR    |
| `format.monetary_precision`  | ERROR    |
| `format.vat_id_checksum`     | ERROR    |
| `format.vat_id_syntax`       | ERROR    |
| `format.vat_id_prefix`       | ERROR    |
| `format.country_code`        | WARNING  |
| `format.postal_code_de`      | WARNING  |
| `format.email`               | WARNING  |
| `format.phone`               | WARNING  |
| `format.bic`                 | WARNING  |
| `format.leitweg_id_checksum` | WARNING  |

ISO 9362 defines no check digit for a BIC, so `format.bic` checks shape only.
`format.leitweg_id_checksum` runs only when `buyerReference` already has the Leitweg-ID
shape (`\d{2,12}[-<fine>]-\d{2}`, KoSIT's Format-Spezifikation v2.0.2). Ordinary purchase
order references are not treated as Leitweg IDs. `format.email` and `format.phone` are
plausibility checks, not RFC-exhaustive
parsers. See [`validation.md`](validation.md) §4 for the shared checksum/shape functions
each of these calls.

**`mandatory.*`: 23 rules.** XRechnung and § 14 UStG completeness.

| Rule                                    | Severity |
| --------------------------------------- | -------- |
| `mandatory.invoice_number`              | ERROR    |
| `mandatory.issue_date`                  | ERROR    |
| `mandatory.currency`                    | ERROR    |
| `mandatory.buyer_identity`              | ERROR    |
| `mandatory.buyer_reference`             | ERROR    |
| `mandatory.electronic_address`          | ERROR    |
| `mandatory.line_amounts`                | ERROR    |
| `mandatory.line_descriptions`           | ERROR    |
| `mandatory.line_vat_rate_or_exemption`  | ERROR    |
| `mandatory.monetary_total`              | ERROR    |
| `mandatory.payment_terms`               | ERROR    |
| `mandatory.seller_contact`              | ERROR    |
| `mandatory.seller_identity`             | ERROR    |
| `mandatory.seller_tax_id`               | ERROR    |
| `mandatory.vat_breakdown`               | ERROR    |
| `mandatory.vat_category`                | ERROR    |
| `mandatory.vat_category_buyer_identity` | ERROR    |
| `mandatory.vat_category_reason`         | ERROR    |
| `mandatory.vat_category_seller_vat_id`  | ERROR    |
| `mandatory.vat_rate_or_exemption`       | ERROR    |
| `mandatory.delivery_date`               | WARNING  |
| `mandatory.party_street`                | WARNING  |
| `mandatory.seller_iban`                 | WARNING  |

`mandatory.party_street` is a WARNING because the project's KoSIT container accepts a
party address without a street. See
[`validation.md`](validation.md) §5.

`mandatory.vat_category` fails a breakdown group whose category and rate disagree — a zero
rate with no category, or a non-`S` category with a non-zero rate.
`mandatory.vat_category_reason` fails when category `E` (§ 4 UStG exemption) carries no
free-text `exemptionReason`. `mandatory.vat_category_buyer_identity` fails when any
breakdown group uses `AE` (reverse charge) or `K` (intra-community supply) but the buyer
has no VAT ID. `mandatory.vat_category_seller_vat_id` fails when `K` has no seller VAT ID.
Those `K` requirements come from the real KoSIT container's BR-IC-02. This project does
not map a seller tax representative identifier, so local validation requires a seller VAT
ID.
See [`validation.md`](validation.md) §5.1 and [`generation.md`](generation.md) §5.2.

**`plausible.*`: 7 rules.** These are non-blocking sanity checks except for line count.

| Rule                         | Severity |
| ---------------------------- | -------- |
| `plausible.line_count`       | ERROR    |
| `plausible.date_order`       | WARNING  |
| `plausible.date_range`       | WARNING  |
| `plausible.magnitude`        | WARNING  |
| `plausible.positive_amounts` | WARNING  |
| `plausible.vat_rate`         | WARNING  |
| `plausible.zero_vat_reason`  | WARNING  |

**`mapping.*`: 15 rules, all ERROR.** Emitted by the XRechnung mapper when data is schema-valid
but cannot be expressed in XRechnung. These replace only the `mapping.`-prefixed findings
of a previous run; validation findings survive.

`mapping.amount_precision`, `mapping.currency`, `mapping.electronic_address`,
`mapping.electronic_address_scheme`, `mapping.generation_failed`, `mapping.invoice_header`,
`mapping.line_item`, `mapping.line_unit`, `mapping.line_vat_category`,
`mapping.party_address`, `mapping.party_country_code`, `mapping.schema`,
`mapping.seller_tax_id`, `mapping.vat_breakdown`, `mapping.vat_breakdown_category`

See [`generation.md`](generation.md) §5 for the rejection conditions.

**`schema.*`: 1 rule, ERROR.** `schema.extracted_data` means the stored extraction does not satisfy
the raw schema at all.

**`kosit.*`: external validation rules.** The generation stage emits these when KoSIT
rejects a document. `kosit.<code>` is KoSIT's own rule code (`BR-CO-09`, `BR-DE-15`, and so
on); its set is defined by the external specification and is not listed here, while the
validator's text is shown as received. `kosit.unspecified` means KoSIT rejected the document
without naming one rule.

## 8. Enums

### `InvoiceStatus`

| Value                 | Meaning                                                      | Terminal             |
| --------------------- | ------------------------------------------------------------ | -------------------- |
| `UPLOADED`            | Accepted, queued for text extraction                         | no                   |
| `EXTRACTING_TEXT`     | Worker claimed text extraction                               | no                   |
| `TEXT_READY`          | Text extracted, queued for the model                         | no                   |
| `EXTRACTING_DATA`     | Worker claimed LLM extraction                                | no                   |
| `DATA_READY`          | Structured data stored, queued for validation                | no                   |
| `VALIDATING`          | Worker claimed validation                                    | no                   |
| `NEEDS_REVIEW`        | A failed ERROR finding blocks generation; user action needed | yes, until corrected |
| `GENERATING`          | Queued for XML generation                                    | no                   |
| `GENERATING_DOCUMENT` | Worker claimed generation                                    | no                   |
| `READY`               | KoSIT-clean XRechnung available for download                 | yes                  |
| `FAILED`              | Irrecoverable; see `failure`                                 | yes                  |

A client polls while the status is non-terminal and stops at `NEEDS_REVIEW`, `READY` or
`FAILED`.

### `SourceType`

`NATIVE` (text layer) · `OCR` (text recognition) · `UNKNOWN`

### `Severity`

`ERROR` (blocks generation when `passed: false`) · `WARNING` · `INFO`

### `PipelineStage`

Wire values are kebab-case: `text-extraction`, `data-extraction`, `validation`,
`generation`.

## 9. Limits and retention

| Setting               | Default | Effect                              |
| --------------------- | ------- | ----------------------------------- |
| `RETENTION_HOURS`     | 2       | Invoice and session-cookie lifetime |
| `MAX_UPLOAD_MB`       | 10      | Upload size ceiling                 |
| `MAX_PAGES`           | 30      | Page-count ceiling                  |
| `RATE_LIMIT_PER_HOUR` | 20      | Upload budget only                  |

After `expiresAt` every endpoint answers `404` for that invoice, before the cleanup sweep
physically deletes it. A UI should show remaining time and treat a `404` on a previously
visible invoice as expiry, not as an error.

## 10. Error response body

`HttpExceptionFilter` (`apps/api/src/http/http-exception.filter.ts`) is the catch-all
`APP_FILTER`, so the shapes below apply to every route.

Every `HttpException` thrown by the API uses two keys. This includes `400`, `401`, `404`,
`409`, and both forms of `413` (upload and JSON body limits):

```json
{ "message": "A valid anonymous session is required", "statusCode": 401 }
{ "message": "Review request has an invalid shape", "statusCode": 400 }
{ "message": "Not Found", "statusCode": 404 }
```

The response does not include an `error` property. `message` is the string supplied by
application code or the framework's fixed default for an exception such as
`NotFoundException()`. Caught error text is not copied into it.

Any other thrown value becomes a `500` with no route-specific detail, stack, or original
error text:

```json
{ "statusCode": 500, "message": "Internal server error" }
```

The `503` response from `GET /health/ready` is the exception to the two-key shape. Its
`ServiceUnavailableException` carries the full dependency status body, which the filter
passes through unchanged. See §4 for that shape.

Rate-limit responses keep their own shape and include a header:

```
Retry-After: 60
{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }
```

`Retry-After` is in seconds, so the UI can show the wait time. The
`message` here is framework text and is not worth showing to a user.

These messages are English, server-generated, and some name internal concepts. Treat them
as diagnostics: key user-facing text off `statusCode` (§11) instead of rendering `message`
directly. Invoice failure messages are the separate
typed `failure` contract above.

## 11. Error handling summary

| Code  | Meaning                                                   | Reasonable client behaviour                                                |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `400` | Malformed request or payload                              | Show what is wrong; do not retry unchanged                                 |
| `401` | No valid session                                          | `POST /sessions`, retry once, then surface                                 |
| `404` | Unknown / not owned / expired / not in the required state | Treat as expired-or-gone                                                   |
| `409` | Lost a race against the lifecycle                         | Re-fetch state, rebuild the view                                           |
| `413` | Upload too large                                          | Local pre-check should prevent it                                          |
| `429` | Rate limited                                              | Back off by `Retry-After` seconds; say which budget was hit; pause polling |
| `5xx` | Server or dependency failure                              | Retry with backoff, preserve unsaved input                                 |
