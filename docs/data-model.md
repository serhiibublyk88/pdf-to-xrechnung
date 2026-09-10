# Data model

[`../apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) is authoritative for
the database structure; this document explains the decisions behind it.

## 1. Design principles

- Each pipeline stage persists its output. Processing is asynchronous, and every worker
  reads the previous stage's result. This allows work to resume after a process failure.

- Raw LLM output is stored untouched so provider errors and parser errors can be diagnosed
  separately.

- Every invoice has a durable `expiresAt` value. Cleanup uses it to remove the row, file,
  and queue diagnostics.

- `ownerId` comes from a server-signed anonymous-session cookie and scopes every invoice
  read and mutation.

## 2. Entity overview

```
Invoice (1) ──── (n) ExtractionAttempt
   │
   ├──────────── (n) ValidationResult
   │
   └──────────── (n) GeneratedDocument

PendingStorageDeletion             durable cleanup marker, independent of Invoice
```

One `Invoice` is one uploaded PDF. It may have several extraction attempts (retry,
different provider, re-run after prompt change), many validation results (one per
rule), and one current generated XRechnung document. `PendingStorageDeletion` survives
logical invoice deletion until the corresponding file has been erased.

## 3. Schema

The full schema lives in [`prisma/schema.prisma`](../apps/api/prisma/schema.prisma) and is
authoritative for the database structure. It defines five models (`Invoice`,
`ExtractionAttempt`, `ValidationResult`, `GeneratedDocument`,
`PendingStorageDeletion`) and four enums (`InvoiceStatus`, `SourceType`, `Severity`,
`DocumentFormat`), matching §2's entity overview.

A few fields carry lifecycle meaning beyond their Prisma types:

| Field           | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `ownerId`       | Anonymous signed-session identity used by every owner-scoped query            |
| `expiresAt`     | Time at which the row becomes inaccessible and eligible for cleanup           |
| `rawResponse`   | Untouched provider output retained to distinguish provider and parser defects |
| `reviewedData`  | Current human-corrected raw-schema value used for generation                  |
| `reviewVersion` | Monotonic correction sequence used by the review capability and write CAS     |
| `failureCode`   | Closed user-visible failure code used by lifecycle guards                     |
| `failureParams` | Numeric interpolation values only; never invoice content                      |

The code stays a plain column because retry-exhaustion and idempotency guards compare it;
the parameters are presentation data and are validated before an API response is built.
Both fields are written and cleared together, including when a dead-letter retry reopens
the invoice.

## 4. Invoice data shape

The extracted invoice itself lives in `ExtractionAttempt.parsedData` as JSON rather
than in relational tables.

The invoice shape is stored as JSON because it is defined by EN 16931, validated by Zod,
kept for only two hours, and never queried across invoices. Normalised tables would add a
second schema that must stay aligned with the shared contract.

The shape is defined in [`extraction.md`](extraction.md) §3 and is not repeated here.

Per-field status for the review UI is derived from raw missing values and
`ValidationResult`; it is not stored separately.

`Invoice.reviewedData` is a second, short-lived source for the same Zod raw schema. A
correction overwrites it only through the owner- and lifecycle-scoped review
transaction. The generation worker prefers it to the latest successful
`ExtractionAttempt.parsedData`; extraction history itself remains untouched for
traceability. Reusing an expired invoice clears `reviewedData` with all other lifecycle
artifacts.

The owner-scoped list uses the `(ownerId, createdAt)` index. The list is ordered newest
first and carries no extracted content.

`ValidationResult` rows carry no lifecycle key of their own. The validation worker
replaces an invoice's findings and commits its `VALIDATING` outcome in one transaction
gated by the compare-and-swap predicate `(id, storageKey, VALIDATING, expiresAt > now)`,
so a worker from a superseded lifecycle writes nothing. Reusing an expired row
clears its findings in the same transaction that assigns the new `storageKey`. Both
guarantees come from those two transactions, not from a column.

The generation worker is the second writer. It stores mapping rejections in the same table
so the review UI can render one findings list ([`generation.md`](generation.md) §2). It
replaces only rows whose `rule` starts with `mapping.`, using a compare-and-swap on
`GENERATING_DOCUMENT`. It does not recompute validation rules or delete rows it cannot
recreate. The prefix separates the two writers; the database schema does not enforce it.

Human correction is the third writer. It is allowed only from `NEEDS_REVIEW` and compares
and increments `reviewVersion` while it replaces the complete finding set, removes any
earlier generated document, stores `reviewedData`, and moves to `NEEDS_REVIEW` or
`GENERATING`. A generated document therefore always belongs to the currently displayed
correction, never a preceding one.

## 5. State machine

```
UPLOADED
   │
   ├─→ FAILED  (the stage retry budget was exhausted)
   │
   ├─→ EXTRACTING_TEXT ─→ TEXT_READY ─→ EXTRACTING_DATA ─→ DATA_READY
   │         │                                  │
   │         └─→ FAILED                         └─→ FAILED
   │            (no pages, too many pages,        (LLM unrecoverable)
   │             no text layer, unreadable PDF)
   │
DATA_READY ─→ VALIDATING
                  │
                  ├─→ NEEDS_REVIEW
                  │
                  └─→ GENERATING
                         │
                         └─→ GENERATING_DOCUMENT ─→ NEEDS_REVIEW | READY
```

The code enforces these rules:

- Transitions are validated; an illegal transition throws
- A failed ERROR rule or deterministic mapping/conformance check routes to
  `NEEDS_REVIEW`; invalid input and exhausted provider-protocol repair route to `FAILED`
- `GENERATING_DOCUMENT` is the exclusive worker claim. Only that status may persist a
  mapping outcome or generated document, so a previous worker cannot complete a newer
  review cycle
- `FAILED` always carries `failureCode`; its optional parameters contain only safe
  numeric display values. It can be reopened only through
  [lifecycle-scoped dead-letter retry](architecture.md#state-transitions)
- A transition to `TEXT_READY` must carry non-empty `extractedText`; the check runs
  before the write, so a producer bug can't persist a durable state the data stage has no
  other way to recover from

The explicit state machine gives each interrupted transition a defined recovery path.
Each pipeline stage has a startup reconciler that re-queues any invoice durably stored for
that stage but missing a job:
`TextExtractionReconciler` does this for `UPLOADED`/`EXTRACTING_TEXT`,
`DataExtractionReconciler` for `TEXT_READY`/`EXTRACTING_DATA`, `ValidationReconciler`
for `DATA_READY`/`VALIDATING`, and `GenerationReconciler` for
`GENERATING`/`GENERATING_DOCUMENT`. A reconciler does not touch an invoice that has already
moved past its stage. If a live process cannot publish the next job after committing the
forward status, the recovery-only edges in `LEGAL_TRANSITIONS` return it to the previous
stage: `TEXT_READY → EXTRACTING_TEXT`, `DATA_READY → EXTRACTING_DATA`, or
`GENERATING → VALIDATING`. See [`architecture.md`](architecture.md#state-transitions).

## 6. Retention and cleanup

| Field                     | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `Invoice.expiresAt`       | `createdAt + 2 hours`; the row becomes eligible for cleanup at this point |
| Cleanup interval          | Every 10 minutes, up to 100 eligible rows per run                         |
| Cascade                   | `onDelete: Cascade` removes attempts, validations, documents              |
| Storage                   | The same job deletes the file via `StorageService`                        |
| Dead-letter queue entries | Removed with their invoice; swept by age otherwise                        |

Two hours is the eligibility point, not a deletion deadline. Removal normally follows on
the next cleanup run. The limit of 100 rows per run or a failed deletion can delay it.

The cleanup job deletes the stored file first, then the row. If it crashes between the two,
the next run finds the expired row and retries the deletion. Child rows carry no
`expiresAt`; they disappear through the parent's cascade.

User-requested deletion uses a separate `PendingStorageDeletion` marker because it removes
the `Invoice` row before erasing the file. The marker and conditional row deletion commit
together; cleanup retries its immutable `storageKey` until physical erasure succeeds.

A dead-lettered text-extraction job (`text-extraction-dlq`, see
[queue semantics](architecture.md#lifecycle-identity-and-queue-semantics)) is not covered by the row's own cascade because it
lives in Redis, not PostgreSQL.
`CleanupService` removes the matching DLQ entry when it deletes an invoice; if that
removal itself fails, the age-based sweep catches it up to one retention window later. A
pipeline stage worker separately refuses to publish a new dead letter for a lifecycle that
has already expired or been deleted, so a cleanup run racing a worker cannot recreate a
diagnosis for a row that is already gone.

Eval data lives in the repository under `apps/api/evals/` and does not use these tables.

## 7. Deduplication

On upload:

1. Compute SHA-256 of the file bytes.
2. Attempt to create an `Invoice` for `(ownerId, fileHash)`.
3. `@@unique([ownerId, fileHash])` lets exactly one concurrent attempt succeed; a
   second request for the same bytes re-reads that row instead of creating another
   one. If that row is still `UPLOADED` (a prior request never finished enqueueing
   it), the repeat request re-saves the file and re-enqueues — idempotent via BullMQ's
   `jobId` dedup. Any later status is served as
   is, with no new work.
4. A row past its `expiresAt` but not yet swept by cleanup is reused in place rather
   than served stale or left blocking a legitimate re-upload.

Scoping by `ownerId` matters: two different sessions uploading the same file must not
see each other's data, even though the bytes are identical. This is upload
deduplication. Extraction-result caching also depends on the provider, model, and prompt
version; see [`extraction.md`](extraction.md) §8.

The concurrency guarantees are summarized in [`architecture.md`](architecture.md).

## 8. Persistence choices

Failed extraction attempts follow the same retention window as successful attempts because
their raw responses may contain invoice data. `promptVersion` remains a readable version
string; report metadata and regression tests provide change control without storing the full
prompt hash in each row.
