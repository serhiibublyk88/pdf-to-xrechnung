# Product and scope

## Domain and intended use

German businesses have had to be able to receive electronic invoices since 1 January
2025, with transitional rules for issuing them through the end of 2027. A plain PDF is an
unstructured “other invoice,” not an e-invoice. For current legal rules, see the
[Federal Ministry of Finance FAQ](https://www.bundesfinanzministerium.de/Content/DE/FAQ/e-rechnung.html).

PDF zu XRechnung lets an invoice issuer import their own PDF or draft, review the extracted
data, and issue an XRechnung 3.0.2 UBL document. If a recipient imports somebody else's PDF,
the output is a structured working copy; it does not retroactively change what the sender
issued. The application is not legal or tax advice.

The repository is a full-stack portfolio project. It demonstrates how to put an unreliable
model inside a reliable workflow without presenting a local development stack as a hosted
commercial product.

## Product flow

```text
PDF upload
  → native text extraction or OCR
  → structured LLM extraction
  → deterministic validation
  → human review when required
  → XRechnung UBL generation
  → KoSIT validation
  → download
```

The user sees the source PDF beside the extracted fields. Missing values, arithmetic
failures, unsupported code-list values, and KoSIT findings return to that workspace. The
system does not use model confidence as permission to skip review.

## Scope

### Included

| Area        | Supported boundary                                                  |
| ----------- | ------------------------------------------------------------------- |
| Input       | Single- and multi-page PDF                                          |
| Text        | Native text layer and bounded Tesseract OCR fallback                |
| Language    | German and English invoice content and UI                           |
| Extraction  | Gemini, Groq, local Ollama, and a deterministic local demo provider |
| Validation  | 65 application rules plus provider-schema validation                |
| Output      | CIUS XRechnung 3.0.2 using UBL syntax                               |
| Conformance | KoSIT must accept a document before it reaches `READY`              |
| Review      | Owner-scoped correction of all extracted invoice fields             |
| Operation   | Docker Compose local stack and CI                                   |
| Measurement | Synthetic native-text and OCR fixtures with dated provider reports  |

### Out of scope

| Excluded                                    | Reason                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| JPEG, PNG, HEIC, and document photos        | Perspective, glare, and camera correction need a different input pipeline                                                                       |
| ZUGFeRD output                              | It adds a PDF/A-3 product surface; this project supports one output profile                                                                     |
| Accounts and password recovery              | Anonymous signed sessions are enough for the local portfolio workflow                                                                           |
| Multi-tenancy, billing, and ERP integration | They do not strengthen the extraction and reliability problem being demonstrated                                                                |
| Reopening a `READY` document                | No current user requires post-issuance editing                                                                                                  |
| External VIES or address lookups            | They introduce another privacy and availability boundary for limited value here                                                                 |
| Separate delivery-address extraction        | The current raw schema carries a delivery date, not a second party address; category `K` therefore assumes delivery to the buyer country        |
| Hosted public demo                          | A shared model key is easy to exhaust, and accepting strangers' invoices creates a data-handling obligation this project does not claim to meet |
| S3 and horizontal worker deployment         | Only local storage and a single application process are implemented and tested                                                                  |

A photo wrapped in a PDF passes the file-type check, but phone photos are not part of the
tested input set. Low-content and low-confidence OCR results return typed failures.

## Guarantees and limits

### What the application guarantees

- `READY` means the current lifecycle passed the implemented deterministic checks and the
  generated document passed KoSIT.
- PostgreSQL is authoritative for invoice state. Redis jobs can be reconstructed from it.
- A worker acts only on `(invoiceId, storageKey, expected status)`, so stale work cannot
  update a reused upload lifecycle.
- Retryable dependency failures use bounded BullMQ retries. Invalid content and violated
  business rules do not spend that retry budget.
- Model output is untrusted: the untouched response is persisted before parsing, validated
  with Zod, and never logged.
- Invoice arithmetic uses decimal coefficients and scales rather than floating point.
- Anonymous ownership, expiry, and no-store HTTP responses prevent one browser session from
  reading another session's live invoice.

### What it does not guarantee

- Internal consistency does not show whether extracted values match the PDF. The source
  therefore remains visible during correction.
- KoSIT conformance does not establish the commercial or tax correctness of an invoice.
- Local disk, one PostgreSQL instance, and one Redis instance do not provide disaster
  recovery or high availability.
- The measured eval result describes 18 synthetic fixtures, not the population of real
  invoices.

## Runtime boundaries

| Boundary                             | Ownership                                             |
| ------------------------------------ | ----------------------------------------------------- |
| PDF parsing and OCR                  | Application, with parsing isolated in a worker thread |
| LLM request and provider wire schema | Application                                           |
| Parsed invoice schema                | Shared contracts package                              |
| Deterministic validation             | Application                                           |
| Invoice lifecycle                    | PostgreSQL through conditional state transitions      |
| Queue delivery and retry             | BullMQ and Redis                                      |
| File storage                         | Local volume behind `StorageService`                  |
| UBL serialization                    | `@e-invoice-eu/core`                                  |
| XRechnung conformance                | KoSIT validator service                               |

The NestJS API and workers share one process, which keeps the local stack small. PostgreSQL
and Redis provide recovery without relying on in-memory coordination. Lifecycle and
recovery details are in [`architecture.md`](architecture.md).

## Data handling and privacy

Invoices can contain names, addresses, tax identifiers, and bank details. The application
therefore avoids using user documents for debugging or evaluation.

| Data                                | Location                            | Retention                |
| ----------------------------------- | ----------------------------------- | ------------------------ |
| Uploaded PDF                        | Local storage under a generated key | Eligible after two hours |
| Extracted text                      | PostgreSQL                          | Eligible after two hours |
| Raw provider response               | PostgreSQL                          | Eligible after two hours |
| Reviewed invoice data               | PostgreSQL                          | Eligible after two hours |
| XML and KoSIT report                | PostgreSQL                          | Eligible after two hours |
| Synthetic eval fixtures and reports | Repository                          | Permanent                |

Eligibility is not an exact deletion timestamp. A periodic cleanup removes expired rows,
files, and queue diagnostics in bounded batches. A concurrent lifecycle reuse is protected
by the same storage-key comparison used by workers.

Original filenames are never used as disk paths. Logs omit invoice content, provider
responses, owner identifiers, filenames, and extracted business fields. Losing the signed
anonymous-session cookie means losing access; there is no account recovery.

Gemini and Groq receive extracted invoice text through external APIs; the PDF itself is not
sent to the model provider. Ollama keeps the model request local. Before deployment, review
the selected provider's data-processing terms.

## Stack

| Layer       | Technology                                                               |
| ----------- | ------------------------------------------------------------------------ |
| Language    | TypeScript, strict mode                                                  |
| Backend     | NestJS                                                                   |
| Frontend    | Next.js App Router, React, Tailwind CSS                                  |
| Persistence | PostgreSQL, Prisma, local file storage                                   |
| Queue       | BullMQ, Redis                                                            |
| Validation  | Zod and exact-decimal domain rules                                       |
| OCR         | Poppler rasterization (`pdftocairo`) and Tesseract                       |
| LLM         | Gemini, Groq, or Ollama                                                  |
| Output      | `@e-invoice-eu/core` and KoSIT                                           |
| Tests       | Jest, Vitest, Playwright, real PostgreSQL/Redis/KoSIT integration suites |
| Runtime     | Docker Compose and GitHub Actions                                        |

## Evidence

The 18-fixture runs use the same pipeline as the application. Each report records the
provider, model, prompt version, source type, timings, individual mismatches, failures, and
conformance result. [`evals.md`](evals.md) owns the scoring, the measured results for Ollama,
Gemini, and Groq, and the limits of what they show.

## Acceptance criteria

### Conformance

The application never serves a generated document as `READY` unless the real KoSIT service
accepted it. Mapping and conformance failures are observable review outcomes.

### Extraction quality

Quality is reported separately for native-text and OCR sources. Critical, important, and
line-item fields use explicit denominators; a false success is tracked separately because
it is more dangerous than a visible review or failure.

### Reliability

The test suite covers duplicate uploads, stale jobs, expiry reuse, crashes between durable
state and queue publication, retry exhaustion, concurrent corrections, cleanup races,
provider failures, invalid model output, KoSIT outages, and owner isolation. Tests that
claim infrastructure behaviour use real PostgreSQL, Redis, filesystem, or KoSIT boundaries.

## Status

The application scope is complete. [`roadmap.md`](roadmap.md) is the only status checklist,
and it also records the measurement work that would extend the project further.
