# Architecture

## Components

```text
apps/api/src/
  config/          Validated environment configuration and the log-redaction paths
  prisma/          Database client and lifecycle
  storage/         Uploaded-file storage boundary and local implementation
  sessions/        Signed anonymous-session cookie issuance and verification
  invoices/        Upload/status/document-download HTTP API and ingestion orchestration
  extraction/      PDF parser, queue producer, worker, and reconciler
  data-extraction/ LLM provider boundary, prompt, attempt runner, queue,
                    worker, and reconciler
  validation/      Deterministic rules, queue, worker, and reconciler
  generation/      XRechnung UBL mapper, KoSIT client, queue, worker, and reconciler
  review/          Owner-scoped list, review, correction, and DLQ HTTP API
  money/           Exact decimal (coefficient/scale) arithmetic
  queue/           Redis connection, queue naming, invoice transitions, the
                    startup recovery every stage shares, and the queue and
                    processor bases all pipeline stages extend
  health/          Liveness and readiness probes, with their own bounded Redis client
  cleanup/         Retention sweep
```

The application is one NestJS process. HTTP handlers and BullMQ workers share that process
but communicate through durable PostgreSQL state and Redis jobs, so recovery does not
depend on in-memory coordination.

```text
apps/web/
  app/[locale]/       App Router pages — upload/list, invoice review workspace,
                      root layout (theme, dictionary), error/not-found/loading
  app/page.tsx        Accept-Language redirect to /de or /en
  proxy.ts            Carries the validated route locale to the root layout request
  components/         App header (segmented locale control, icon theme toggle),
                      demo-mode notice, upload dropzone, grouped work list,
                      pipeline stepper
  components/review/  Review-workspace parts — pipeline/status panels, blocking
                      summary, correction form groups, confirm step, PDF panel,
                      the full findings record
  lib/api/            Zod schemas for the response envelopes (the invoice contract
                      itself comes from @pdf-to-xrechnung/contracts), typed fetch
                      client with the 401-retry/404/409/413/429 error matrix, and
                      the single place an ApiError becomes user-facing text
  lib/i18n/           German-source, English-derived dictionaries; the
                      BT/BG-anchored field-label and 65-rule catalogues; the
                      finding field-path formatter
  lib/pipeline/       Eleven InvoiceStatus values collapsed to the five stages
                      the UI shows, with the fact each completed stage states
  lib/theme/          Graphite-dark-by-default theme, anti-flash inline script
  lib/format/         Expiry countdown formatting and the shared "now" clock
  lib/invoices/       Typed failure codes rendered as localized reader-facing text
  lib/polling/        Interval that pauses on a hidden tab and catches up on return
  lib/review/         The editable draft and its wire-shape validation, the
                      review-workspace lifecycle reducer, finding
                      sort/grouping/field binding, work-list grouping
  e2e/                Playwright tests for the upload-to-download flow
```

```text
packages/contracts/src/  @pdf-to-xrechnung/contracts workspace package — everything both
                      apps/api and apps/web must agree on, defined once: the Zod
                      invoice wire contract and its patterns, the Zod failure
                      contract, IBAN/VAT-ID/Leitweg-ID checksums, BIC and
                      email/phone plausibility, the German-postal-code shape, the
                      UN/ECE unit-code table and the electronic-address-scheme list
```

### Frontend behaviour

#### Locale switching

`proxy.ts` copies the validated locale route segment into a request header so the root
layout can render the
initial `<html lang>` correctly. Reading that header makes the locale routes dynamic SSR,
so they do not use `generateStaticParams`. Once loaded, a locale link uses
shallow `history.pushState` and client-held dictionary state: a route navigation would
remount the review page and discard an in-progress correction draft. The client therefore
updates `lang`, title, and description itself; this avoids a second review/status request
and keeps the draft intact.

#### Correction draft

`lib/review/draft.ts` keeps every value as text, including `lineItems[].position`, which is
a number on the wire. It converts through `rawExtractedInvoiceDataSchema` only at submit.
That keeps a rejected
keystroke on screen and attributable to its field instead of surfacing as a failed request,
and it is why no exception can cross the `ApiResult` boundary. The client validates the
wire shape only. The [65 business rules](api-contract.md#72-rule-catalogue-65-application-rules)
run on the server, so the two cannot disagree about what is submittable. Seven non-blocking
checks (IBAN/VAT-ID/Leitweg-ID checksum, German
postal-code shape, email/phone plausibility, BIC format) mirror specific server-side
field rules using the same `@pdf-to-xrechnung/contracts` functions the server calls. These
checks surface likely typos before a round trip but never block submission; the server
always runs them again.

#### Finding placement

`field` paths from [`api-contract.md`](api-contract.md) §7.1 are the join key between a
server finding and a
form input, so a failed check appears with `aria-describedby` on the field itself rather
than in a parallel list. The blocking summary above the form is derived from the same
array and moves focus rather than only scrolling.

#### Source document

Deterministic validation can check consistency and completeness, but only the user can
compare extracted data with the PDF. The desktop review workspace therefore shows the form
and source side by side. The source pane is collapsible at `lg` and above; on smaller
screens, the form and document use tabs.

The browser never calls `apps/api` directly: `next.config.ts`'s `rewrites()` proxies
`/api/*` to the API origin, so every request is same-origin from the browser's
perspective and the session cookie needs no cross-site attributes. See
[`api-contract.md`](api-contract.md) §1 and
[`operations.md`](operations.md#configuration).

## HTTP surface

This section is a summary. [`api-contract.md`](api-contract.md) defines the exact request
and response shapes, status codes, and enum values.

| Endpoint                               | Purpose                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /sessions`                       | Issue an HttpOnly, signed anonymous owner cookie (`204`)                               |
| `POST /invoices`                       | Validate, deduplicate, persist, enqueue, and return `202`                              |
| `GET /invoices`                        | List the caller's live invoices                                                        |
| `GET /invoices/:id`                    | Return owner-scoped status and safe processing metadata                                |
| `GET /invoices/:id/source`             | Serve the caller's original PDF inline                                                 |
| `GET /invoices/:id/document`           | Serve owner-scoped XRechnung UBL only for `READY`                                      |
| `GET /invoices/:id/review`             | Return extracted/reviewed fields, findings, DLQ diagnosis, and a correction capability |
| `POST /invoices/:id/review`            | Persist a correction and enqueue valid regeneration (`202`)                            |
| `POST /invoices/:id/dead-letter/retry` | Retry the current lifecycle's one DLQ entry (`204`)                                    |
| `DELETE /invoices/:id`                 | Delete a resting lifecycle and arrange durable file cleanup (`204`)                    |
| `GET /extraction-mode`                 | Tell the UI whether uploads use the mock provider's fixed demo data                    |
| `GET /health/live`                     | Confirm the process can answer requests                                                |
| `GET /health/ready`                    | Probe PostgreSQL, Redis and the KoSIT validator, each reported on its own              |

`RATE_LIMIT_PER_HOUR` bounds the one expensive operation, the upload, and is the default
every other route would otherwise inherit. Reading status, listing invoices, submitting a
correction, minting a session and retrying a dead letter cost a query or two each, so they
declare their own per-minute bounds instead of spending the upload budget. Responses that
carry invoice data are sent `Cache-Control: no-store`.

The DLQ diagnosis includes the stage and failure time, but not the underlying error text.
The invoice's typed `failure` payload contains the user-facing reason. A retry returns `409`
when the lifecycle has moved, the job is already running again, or the entry is gone.

`InvoicesController` handles upload, status, source, and document routes;
`ReviewController` handles the list, review detail, correction, deletion, and DLQ retry.
Both are thin HTTP layers over `InvoicesService` and `ReviewService`. They remain separate
because `ReviewModule` pulls in four queues, the state machine, and the validator that
`InvoicesModule` does not otherwise need.

Every invoice endpoint requires the valid anonymous session cookie. Identity lifetime and
data retention are separate concerns that happen to share `RETENTION_HOURS`: the cookie
says who the caller is, `Invoice.expiresAt` says how long the data lives. They are tied
together by one invariant: a session always outlives every invoice it owns. Uploading an
invoice refreshes the cookie for the same owner. `POST /sessions` refreshes it too, so a
reloaded page keeps its identity, but the guarantee does not depend on the client calling
it. Access therefore
ends at the invoice's own `expiresAt`, even before the asynchronous cleanup sweep deletes
the row. A request for another owner or an expired invoice returns `404`; invalid or
absent session cookies return `401`. Responses never expose extracted text or raw model
output.

Losing the cookie means losing access: there is no account, so there is no recovery. Access
also ends at invoice expiry; physical cleanup follows on the periodic sweep.

## Upload flow

```text
HTTP upload
  → validate PDF and hash bytes
  → create or reuse owner-scoped Invoice
  → persist bytes under storageKey
  → enqueue { invoiceId, storageKey }
  → return UPLOADED

Text-extraction worker
  → verify invoice lifecycle, expiry, and owned status
  → transition to EXTRACTING_TEXT
  → read stored PDF
  → parse each page in an isolated worker thread
  → validate page and text bounds
  → transition to TEXT_READY or a deterministic FAILED result
  → enqueue { invoiceId, storageKey } for data extraction

Data-extraction worker
  → verify invoice lifecycle, expiry, and TEXT_READY/EXTRACTING_DATA status
  → transition to EXTRACTING_DATA
  → reuse an existing successful ExtractionAttempt for the current
    (invoiceId, provider, model, promptVersion), if one exists
  → otherwise call LlmProvider.extract, with one local repair attempt on a
    malformed/schema-invalid response
  → persist the ExtractionAttempt (raw response always; parsed data only on
    a schema-valid response)
  → transition to DATA_READY, or a deterministic FAILED result (schema
    violation surviving repair, or a schema-valid but entirely empty result)
  → enqueue { invoiceId, storageKey } for validation

Validation worker
  → verify invoice lifecycle, expiry, and DATA_READY/VALIDATING status
  → transition to VALIDATING
  → re-validate the latest successful persisted ExtractionAttempt against the raw schema
  → run exact-decimal rules, then replace this invoice's findings
  → atomically transition to NEEDS_REVIEW on any ERROR, otherwise GENERATING
  → enqueue { invoiceId, storageKey } for generation

Generation worker
  → verify invoice lifecycle, expiry, and GENERATING/GENERATING_DOCUMENT status
  → atomically claim GENERATING → GENERATING_DOCUMENT
  → use reviewedData when a correction exists, otherwise the latest successful
    persisted ExtractionAttempt
  → map it to an XRechnung UBL Invoice, rejecting unknown unit/VAT-category/
    currency/country/electronic-address-scheme mappings deterministically
  → on a mapping rejection: replace only this invoice's mapping.* findings, leaving the
    validation findings intact, and transition to NEEDS_REVIEW
  → otherwise: generate the XML, submit it to the KoSIT validator
  → atomically persist the GeneratedDocument and transition to READY (KoSIT-valid)
    or NEEDS_REVIEW (KoSIT-invalid)
```

## Review and correction flow

`GET /invoices/:id/review` returns an opaque HMAC capability only while the invoice is in
`NEEDS_REVIEW`. It binds the owner, invoice ID, `storageKey`, expiry, and current
`reviewVersion`; the client never receives either lifecycle field. The correction endpoint
must receive that capability with a Zod-valid correction.
`InvoiceStateMachine.reviewCorrection()` compares `(id, storageKey, reviewVersion,
NEEDS_REVIEW, expiresAt > now)` and increments the version in the same transaction that
stores `reviewedData`, replaces findings and generated documents, and moves to
`NEEDS_REVIEW` (the correction still fails validation) or `GENERATING`. Ownership is
verified against a fresh row before that lifecycle-scoped write.

Redis enqueue happens after that transaction. If it throws, `InvoiceStateMachine.transition()`
returns `GENERATING` to `NEEDS_REVIEW` so the same request is retryable. If the process
dies after the transaction instead, `GenerationReconciler` recovers the durable
`GENERATING` state on startup. An enqueue whose outcome was uncertain is safe: any job
that sees `NEEDS_REVIEW` is stale and exits without mutation.

The text-extraction worker thread isolates `pdf-parse` CPU/native state from Nest's
event loop and is terminated after every parse. This also prevents the native canvas
garbage-collector handle from leaking into the application or test process.

## Lifecycle identity and queue semantics

An invoice row can be reused after expiry, so `invoiceId` alone does not identify a
processing lifecycle. `storageKey` changes on reuse and is included in every active
job, transition predicate, and dead-letter record.

All four stages share one implementation of these mechanics: `PipelineStageQueue`
(`apps/api/src/queue/pipeline-stage-queue.ts`) handles enqueue, dead-lettering, retry-exhaustion
finalization, failed-job reconciliation and DLQ retry, and each stage subclasses it with
its own queue names, claim statuses, retry-exhausted reason and reopen target. The
shared class has four concrete consumers.

A stage declares `claimFrom`, the status before work starts, and `claimTo`, the status held
while it runs. Retry finalization and startup reconciliation derive their status sets from
that pair, which keeps them aligned with the queue.

Before stage-specific work, `PipelineStageProcessor` checks whether the job belongs to the
current lifecycle and takes the claim. Stale work is dropped; a matching lifecycle already
failed at this stage is dead-lettered. Stage-specific preconditions run between those two
steps.

Active job IDs are derived from `(stage, invoiceId, storageKey)`. A stale job therefore
cannot block a new lifecycle and cannot mutate it. The dead-letter queue keeps one
diagnostic entry per `(stage, invoiceId, storageKey)`.
A correction can return an invoice to `GENERATING` while the generation job that rejected
the previous correction is still finishing under the same ID; BullMQ then discards the new
enqueue as a duplicate. When a generation job completes, the worker therefore republishes
it if the same lifecycle is back in `GENERATING`. The generator always reads the current
reviewed data after claiming, so whichever run claims the lifecycle generates the latest
correction.
A retry (`PipelineStageQueue.retryFromDlq`) discards a retained failed primary job before
reopening. This prevents startup reconciliation from failing the lifecycle again after a
crash immediately following the reopen. It then republishes the active job and removes the
dead letter last. A crash or a concurrent retry that already reopened and republished is
resolved by reading the actual primary job state: a non-failed job at that ID means
publication already happened, and the retry finishes the idempotent dead-letter cleanup
instead of erroring or duplicating the job.

| Failure class                                                                     | Handling                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Storage/provider transport failure, timeout, 429/5xx                              | BullMQ retry with backoff                                                               |
| Corrupt, empty, oversized, or unusable scanned content                            | Deterministic `FAILED`, no retry                                                        |
| Malformed/schema-invalid LLM response, repair exhausted                           | Deterministic `FAILED`, no retry                                                        |
| Schema-valid but entirely empty LLM response                                      | Deterministic `FAILED`, no retry                                                        |
| Missing/corrupt persisted extraction data or validation ERROR                     | Deterministic `NEEDS_REVIEW`, no retry                                                  |
| PostgreSQL/Redis failure while validating                                         | BullMQ retry with backoff                                                               |
| Unmapped unit/VAT category/currency/country/electronic-address scheme             | Deterministic `NEEDS_REVIEW`, no retry                                                  |
| Amount with more than two decimal places at the mapping boundary                  | Deterministic `NEEDS_REVIEW`, no retry                                                  |
| XRechnung generator rejects the mapped invoice against its own schema             | Deterministic `NEEDS_REVIEW`, no retry                                                  |
| XRechnung generator fails for any other reason                                    | BullMQ retry with backoff                                                               |
| KoSIT transport failure or response without a parseable report                    | BullMQ retry with backoff                                                               |
| KoSIT rejects the generated document                                              | Deterministic `NEEDS_REVIEW`, report persisted, no retry                                |
| Retry budget exhausted                                                            | Diagnostic DLQ entry, then lifecycle-scoped `FAILED`                                    |
| Process dies after persistence but before enqueue                                 | Startup reconciler re-enqueues                                                          |
| Process dies after a successful attempt but before its DATA_READY transition      | Reconciler re-enqueues; the existing attempt is reused, not redone                      |
| Process dies during validation                                                    | Validation reconciler re-enqueues; results and status are atomically replaced           |
| Process dies during generation                                                    | Generation reconciler re-enqueues; document and status are atomically replaced          |
| Text-extraction to data-extraction enqueue is rejected while the process is alive | Conditional rollback to `EXTRACTING_TEXT`; the text job's own BullMQ retry republishes  |
| Data-extraction to validation enqueue is rejected while the process is alive      | Conditional rollback to `EXTRACTING_DATA`; the data job's own BullMQ retry republishes  |
| Validation to generation enqueue is rejected while the process is alive           | Conditional rollback to `VALIDATING`; the validation job's own BullMQ retry republishes |
| Generation enqueue fails after a valid correction                                 | Conditional rollback to `NEEDS_REVIEW`; caller receives retryable `503`                 |
| Correction enqueued while the rejecting generation job is still active            | Worker republishes the generation job when the active one completes                     |
| Stale or expired job                                                              | Worker exits without mutation                                                           |
| Application shuts down while a stage job is running                               | Stage workers close first and let the job finish before the database client disconnects |

### Startup reconciliation

- Text extraction scans unexpired `UPLOADED` and `EXTRACTING_TEXT` rows. A missing file in
  `UPLOADED` is left for a repeat upload. In `EXTRACTING_TEXT`, the row is re-enqueued so the
  real read failure uses the normal retry budget and can reach
  `text_extraction_retries_exhausted`.
- Data extraction scans `TEXT_READY` and `EXTRACTING_DATA`. Empty `extractedText` is
  classified by the processor after it claims the row.
- Validation scans `DATA_READY` and `VALIDATING` and reads the persisted extraction
  attempt; it does not need the source file or extracted text.
- Generation scans `GENERATING` and `GENERATING_DOCUMENT` and uses reviewed data when
  present, otherwise the persisted extraction attempt.

Text and data extraction use `requeueStrandedInvoices`
(`apps/api/src/queue/stranded-invoices.ts`). It pages by `id > lastSeenId`, so deleting the
last row of one page does not skip the next row. A concurrent insert below the current
high-water mark is picked up on the next startup. Reconciliation selects only
`(id, storageKey)` and does not load invoice text into a batch.

## State transitions

The implemented transition table is small:

```text
UPLOADED         → EXTRACTING_TEXT | FAILED
EXTRACTING_TEXT  → TEXT_READY      | FAILED
TEXT_READY       → EXTRACTING_DATA | EXTRACTING_TEXT
EXTRACTING_DATA  → DATA_READY      | FAILED
DATA_READY       → VALIDATING      | EXTRACTING_DATA
VALIDATING       → NEEDS_REVIEW    | GENERATING
NEEDS_REVIEW     → NEEDS_REVIEW    | GENERATING
GENERATING       → GENERATING_DOCUMENT | NEEDS_REVIEW | VALIDATING
GENERATING_DOCUMENT → NEEDS_REVIEW | READY
FAILED           → EXTRACTING_TEXT | EXTRACTING_DATA | VALIDATING | GENERATING
```

`NEEDS_REVIEW → NEEDS_REVIEW` is a resubmitted correction that still fails validation;
`GENERATING → NEEDS_REVIEW` is the correction flow's rollback when the regeneration
enqueue fails before a worker claims the job. `TEXT_READY → EXTRACTING_TEXT`,
`DATA_READY → EXTRACTING_DATA` and `GENERATING → VALIDATING` are the equivalent rollback
for the three internal forward handoffs
(`publishNextStage`, `apps/api/src/queue/pipeline-stage-queue.ts`): a producer
that just committed its own forward status rolls itself back to the in-flight status it
came from when the next stage's enqueue is rejected. Its own BullMQ retry can then
republish the job without waiting for a process restart. The CAS behind every edge means a
rollback that loses a race to a consumer that already claimed the row is a no-op, never an
unconditional backward write. All of them are entries in `LEGAL_TRANSITIONS`; no caller
bypasses `InvoiceStateMachine` when writing lifecycle state.

The `FAILED` edges are available only to lifecycle-scoped dead-letter retry. They reopen
the stage named by the current dead-letter entry; ordinary processing never leaves
`FAILED` on its own.

`InvoiceStateMachine.transition()` first rejects a status pair that is not in
`LEGAL_TRANSITIONS`, then performs one conditional update. Its compare-and-swap predicate
includes invoice ID, storage key, current status, and `expiresAt > now`; the result is
`claimed` or `lost`, so a caller that lost the lifecycle stops without another write.
Administrative DLQ recovery follows the same lifecycle predicate.
`failIrrecoverably()` is shared across all queues; each queue passes the statuses derived
from its own claim pair, so one stage's retry-exhaustion can never hard-fail an invoice
that actually belongs to another stage.

`InvoicesService` handles creation and expiry reuse; `CleanupService` handles deletion.
Expiry reuse resets the row and deletes child artifacts atomically after the old file
has been removed. Cleanup deletes the row only when the storage key and expiry still
match its original snapshot, preventing a concurrent reuse from being deleted. It also
sweeps the active and dead-letter queues for all four stages.

## Deduplication

`@@unique([ownerId, fileHash])` closes concurrent upload races. The first insert wins;
the loser re-reads the row.

- A live row past `UPLOADED` is returned as `deduplicated: true` without new work.
- An `UPLOADED` row is re-saved and re-enqueued so a prior storage/enqueue failure can
  heal on the next request.
- An expired row is reused with a new `storageKey` and cleared child artifacts.
- Different owners never share rows or extraction results.

Extraction-result reuse is separate from upload deduplication: an `ExtractionAttempt`
is only reused when it matches the current `(invoiceId, provider, model,
promptVersion)` and produced schema-valid `parsedData`. Bumping `promptVersion` or
switching provider cannot reuse a stale parse.

## Retention

`expiresAt` marks eligibility, not an exact deletion deadline. The periodic cleanup
processes at most 100 rows per run. It removes the file first, deletes the matching
database snapshot second, and removes the associated DLQ entry. An age-based DLQ sweep
catches orphaned diagnostics.

## Verification boundaries

Unit tests cover branching and error classification. Queue mechanics use a real Redis.
E2E tests use a unique PostgreSQL schema, Redis prefix, and temporary storage directory
for every Jest run, then remove only those resources. Concurrent-transition and
cleanup/reuse races run against real PostgreSQL.
`apps/api/test/review.e2e-spec.ts` covers the owner-scoped review route through a real KoSIT
generation and XML download, stale capability rejection, and retryable enqueue failure.
`apps/api/test/state-machine-transitions.e2e-spec.ts` covers the stale-generation and expiry
guards against real PostgreSQL.
