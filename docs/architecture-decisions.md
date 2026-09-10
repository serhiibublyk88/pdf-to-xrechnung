# Architecture Decision Records

Each record states context, decision, and consequences. Amendments remain visible when
they explain the current boundary.

| #                 | Decision                                                         | Status   |
| ----------------- | ---------------------------------------------------------------- | -------- |
| [0001](#adr-0001) | Reuse an existing library for XML generation                     | Accepted |
| [0002](#adr-0002) | `e-invoice-eu` over `node-zugferd`                               | Accepted |
| [0003](#adr-0003) | Queue-based pipeline instead of synchronous processing           | Accepted |
| [0004](#adr-0004) | Deterministic validation layer separate from the LLM             | Accepted |
| [0005](#adr-0005) | Human-in-the-loop instead of full automation                     | Accepted |
| [0006](#adr-0006) | Anonymous sessions instead of accounts                           | Accepted |
| [0007](#adr-0007) | Swappable implementations behind interfaces                      | Accepted |
| [0008](#adr-0008) | Credential-free local walkthrough                                | Accepted |
| [0009](#adr-0009) | Two-hour data retention                                          | Accepted |
| [0010](#adr-0010) | XRechnung UBL as the primary output                              | Accepted |
| [0011](#adr-0011) | Accept the `deepmerge-ts` advisory instead of downgrading Prisma | Accepted |
| [0012](#adr-0012) | Prisma enums as the domain vocabulary                            | Accepted |
| [0013](#adr-0013) | Structured stage-completion logs instead of OpenTelemetry        | Accepted |
| [0014](#adr-0014) | Two-key error bodies instead of RFC 9457 Problem Details         | Accepted |
| [0015](#adr-0015) | Security headers belong to the process serving the document      | Accepted |
| [0016](#adr-0016) | Browser-side reads for the review workflow                       | Accepted |
| [0017](#adr-0017) | Locale switching preserves an in-progress draft                  | Accepted |
| [0018](#adr-0018) | Reviewer picks the VAT category; the model never guesses it      | Accepted |

---

## ADR-0001

### Reuse an existing library for XML generation

**Status:** Accepted · 2026-08-07

**Context.** The system must emit EN 16931-conformant XML. Implementing this from
scratch means encoding a large European standard: element ordering, code lists,
cardinalities, profile rules. Mature open-source implementations already exist.

**Decision.** Generate XML through an existing library. Application code covers extraction,
validation, review and orchestration.

**Consequences.**

- Application code stays focused on extraction, validation, review, and orchestration
- A dependency now sits on the critical path, mitigated by validating its output with
  the independent KoSIT validator (ADR-0004)
- A non-conformant library would need replacement; KoSIT verification keeps that dependency
  failure visible

`@e-invoice-eu/core` 3.2.0 generates the project's XRechnung UBL fixtures with zero KoSIT
errors or warnings in the real generation e2e suite.

---

## ADR-0002

### `e-invoice-eu` over `node-zugferd`

**Status:** Accepted · 2026-08-07

**Context.** The TypeScript candidates were `e-invoice-eu`, which supports UBL and
XRechnung directly, and `node-zugferd`, whose primary boundary is ZUGFeRD/Factur-X in CII.

**Decision.** `@e-invoice-eu/core`.

**Rationale.** Direct XRechnung UBL support is a requirement, not a preference: it is the
project's primary output (ADR-0010). The selected package also exposes the schema and
generation boundary needed by the TypeScript application.

**Consequences.**

- `@e-invoice-eu/core` remains a third-party dependency under its own WTFPL license
- Output still requires independent KoSIT validation; the library is not treated as the
  conformance authority

---

## ADR-0003

### Queue-based pipeline instead of synchronous processing

**Status:** Accepted · 2026-08-07

**Context.** Processing a PDF involves OCR (seconds) and an LLM call (seconds to tens
of seconds), both able to fail transiently. A synchronous request/response would tie
this to an HTTP connection.

**Decision.** BullMQ with Redis. Each pipeline stage is a job; state is persisted
between stages.

**Consequences.**

- Upload returns immediately; the UI polls status
- Transient failures are retried with exponential backoff instead of surfacing as errors
- Transient failures that exhaust their retry budget land in a visible, retryable
  dead-letter queue; deterministic content failures do not spend that budget
- A worker killed mid-job is recovered on the next application restart, because state
  lives in the database rather than in process memory and each stage's startup
  reconciler re-queues work whose job didn't survive — not automatically the instant it
  dies
- Cost: more moving parts and a state machine to maintain. The reliability scenarios in
  [`PROJECT.md`](PROJECT.md#reliability) covers these failure modes

---

## ADR-0004

### Deterministic validation layer separate from the LLM

**Status:** Accepted · 2026-08-07

**Context.** LLMs hallucinate. OCR misreads digits. Both produce plausible-looking
wrong data. Prompt engineering reduces the rate but provides no guarantee.

**Decision.** A validation layer independent of the model: arithmetic reconciliation,
checksums (USt-IdNr, IBAN), § 14 UStG completeness, plausibility bounds. Errors block
XML generation. Additionally, generated XML is submitted to the KoSIT
validator.

**Consequences.**

- One mechanism defends against two unrelated failure sources: model error and OCR error
- The prompt must instruct the model never to calculate missing values; a helpful model
  computing a total would make arithmetic checks worthless
- XRechnung conformance is checked externally by KoSIT rather than asserted by the mapper
- Legitimate edge cases (document-level discounts) trip the checks and need separate
  handling (see [`validation.md`](validation.md) §3)
- Without this layer, a hallucinated total or a misread digit would reach XML
  generation unchecked. See [`validation.md`](validation.md) §1 for the boundary

---

## ADR-0005

### Human-in-the-loop instead of full automation

**Status:** Accepted · 2026-08-07

**Context.** A fully automatic converter must either accept uncertain output or
reject anything imperfect. Invoices carry legal and financial weight; a wrong VAT
amount is not a cosmetic defect.

**Decision.** An extracted invoice that fails a blocking validation, mapping, or
conformance check routes to a review UI showing the PDF beside the fields. Self-reported
model confidence does not participate in routing.

**Consequences.**

- Uncertain invoices remain visible to the user
- The eval suite measures automation rate
- The review UI is part of the correctness boundary, not an optional presentation layer
- Deterministic checks carry the routing decision

---

## ADR-0006

### Anonymous sessions instead of accounts

**Status:** Accepted · 2026-08-07

**Context.** The delivered target is a local portfolio stack with short-lived invoice data.
Accounts would add credential recovery and persistent identity without strengthening the
pipeline being demonstrated.

**Decision.** Use a signed anonymous session cookie carrying a UUID stored as `ownerId`,
without accounts or credentials. Rate-limit uploads.

**Rationale.** A signed anonymous identity supports owner isolation and stale
lifecycle protection while keeping the local workflow immediate.

**Consequences.**

- A reader can use the local stack without creating an account
- Losing the cookie means losing access; there is no recovery path
- Every invoice query still scopes by `ownerId` and expiry
- Upload rate limiting is required even without accounts

---

## ADR-0007

### Swappable implementations behind interfaces

**Status:** Accepted · 2026-08-07

**Context.** Provider APIs, PDF extraction, and file storage have different failure and
testing boundaries from the pipeline that consumes them.

**Decision.** Each sits behind an interface: `LlmProvider`, `TextExtractor`,
`StorageService`.

**Consequences.**

- Gemini, Groq, Ollama, and the deterministic provider share one application contract
- Unit tests can substitute external boundaries while integration/e2e tests keep real
  infrastructure where its behaviour matters
- OCR routing remains explicit in the extraction processor
- Each interface has a current implementation and consumer

---

## ADR-0008

### Credential-free local walkthrough

**Status:** Accepted · 2026-08-17

**Context.** A reader should be able to run the project without provider credentials or
paid quota.

**Decision.** `LLM_PROVIDER=mock` is the local default. It returns one fixed synthetic
invoice, so a reader can exercise validation, review, KoSIT, and download without a key.
There is no seeded database and no retention exemption. Production mode rejects the mock
provider.

**Consequences.**

- A clean clone starts after copying the example environment file
- CI is deterministic and free
- The credential-free path does not demonstrate extraction quality; README and UI wording
  must say that plainly
- A real provider must be selected in configuration

---

## ADR-0009

### Two-hour data retention

**Status:** Accepted · 2026-08-07

**Context.** Invoices contain personal data: names, addresses, bank details. The
pipeline is asynchronous, so intermediate artifacts must persist between stages, and
review requires the source PDF. But nothing needs to persist beyond the working session.

**Decision.** All user data (PDF, invoice metadata, extracted text, raw LLM response,
generated XML, validation reports) becomes eligible for deletion two hours after upload,
removed by the periodic cleanup job within its own cadence ([`data-model.md`](data-model.md)
§6).
Quality measurement uses a synthetic dataset in the repository instead.

**Rationale.** The local workflow normally takes minutes. Matching invoice access and
session lifetime keeps the policy understandable while leaving enough time for review.

**Consequences.**

- Enforced by schema (`expiresAt`) and a cleanup job, not by discipline
- Debugging works on synthetic data, never on user uploads
- Logs must exclude invoice values, or they become a hidden data store outliving retention
- Less privacy exposure than indefinite retention, without claiming production data
  governance

---

## ADR-0010

### XRechnung UBL as the primary output

**Status:** Accepted · 2026-08-07

**Context.** EN 16931 can be expressed in UBL or CII. This project needs a standalone
XRechnung document; ZUGFeRD would add a PDF/A-3 container and a second product boundary.

**Decision.** CIUS XRechnung 3.0.2, UBL syntax — EN 16931 is the semantic base
standard XRechnung is a CIUS of, not a profile name itself; "COMFORT" is a
ZUGFeRD/Factur-X profile name and does not apply here. ZUGFeRD output is out of scope.

**Rationale.** UBL is more readable during debugging, which matters when the XML will
be inspected hundreds of times. XRechnung is validated directly by KoSIT without
unpacking from a PDF container. ZUGFeRD adds PDF/A-3 conformance: metadata and ICC
profile issues that consumed effort even in mature libraries.

**Consequences.**

- The repository name `pdf-to-xrechnung` is accurate
- The application exposes one documented output profile
- The application schema exposes only XRechnung document formats

---

## ADR-0011

### Accept the `deepmerge-ts` advisory instead of downgrading Prisma

**Status:** Accepted · 2026-08-24 · Updated 2026-09-07

**Context.** `npm audit --omit=dev` reports four high-severity findings from
`deepmerge-ts` and `mysql2` in the Prisma CLI dependency graph. The application uses
PostgreSQL and does not load either package at runtime. `npm audit fix --force` proposes a
major Prisma downgrade.

The advisory is not reachable from untrusted input.
`@prisma/config` is loaded by the Prisma CLI when it reads `prisma.config.ts`; the running
application never loads it, because `@prisma/client` depends only on
`@prisma/client-runtime-utils` and `PrismaService` constructs its client from
`ConfigService` rather than from the config file. The merged input is the repository's own
config plus CLI defaults, so no uploaded PDF or HTTP request reaches this code.
The installed Prisma 7 line has no compatible fixed dependency graph. An npm override was
tested and rejected because it removed the pinned package and made `prisma migrate` fail.

**Decision.** Stay on Prisma 7 and carry the advisory in the one-shot `migrate` image.
`prisma` is a development dependency; `apps/api/Dockerfile` builds a migration target with
the CLI, schema and migrations, then prunes development dependencies with legacy peer
resolution for the long-running `api` target. Re-check when Prisma publishes a compatible
fixed graph.

**Rationale.** Downgrading would break the current Prisma setup without removing a runtime
exposure. In Prisma 7, this project's `DATABASE_URL` is wired through `prisma.config.ts`, and the
explicit `@prisma/adapter-pg` setup and migrations are built on that line. A high
severity score describes the advisory, not this system's exposure to it.

**Consequences.**

- The source lockfile keeps the migration graph, so its audit output is not a statement
  about the API artifact; CI instead verifies the API image excludes the three packages
- The exposure argument above is the thing to re-verify, not the advisory count. It stops
  holding the moment application code starts loading `prisma.config.ts`
- Prisma stays pinned to the 7 line until the upstream pin moves

---

## ADR-0012

### Prisma enums as the domain vocabulary

**Status:** Accepted · 2026-09-03

**Context.** `Severity` and `InvoiceStatus` are Prisma-generated enums. Pure logic imports
them directly from `@prisma/client` — `invoice-validator.ts`'s rule files
(`validation/rules/shared.ts`, `completeness.ts`, `formats.ts`, `plausibility.ts`, each
importing `Severity`) and `xrechnung-mapper.ts:2` — and both enums travel out verbatim in
HTTP responses. The database schema is therefore authoritative for this
vocabulary: renaming or removing a member is at once a Prisma migration and a breaking API
change, not a private refactor.

**Decision.** Keep the Prisma enums as the shared vocabulary. Do not add a parallel enum or
a translation layer at the validation/generation boundary.

**Rationale.** A parallel enum would create two representations of the same vocabulary and
a mapping at every boundary without a current semantic difference. `Severity`'s three
values (`ERROR`/`WARNING`/`INFO`) and
`InvoiceStatus`'s lifecycle states are stable domain concepts already shared by persistence
and the HTTP contract.

**Consequences.**

- A `Severity`/`InvoiceStatus` member rename or removal must be reviewed as both a schema
  migration and an API contract change in the same pass. There is no layer that would
  absorb one without the other
- Pure validation and generation logic has a compile-time dependency on `@prisma/client`'s
  generated types; these modules cannot be built or unit-tested fully independent of the
  ORM. The rest of the codebase already depends on those generated types. Decoupling only
  this logic would move the mapping cost without removing the dependency
- A separate mapping belongs only at a boundary whose vocabulary genuinely differs

---

## ADR-0013

### Structured stage-completion logs instead of OpenTelemetry tracing

**Status:** Accepted · 2026-09-04

**Context.** Pipeline failures and latency need enough structure to diagnose a local run,
but the project has no deployed tracing collector or metrics backend.

**Decision.** No tracing SDK, no `traceparent` propagation through BullMQ job data, no
`/metrics` endpoint. Instead, `logStageEvent()` (`src/queue/stage-event.ts`) is called from
the shared `PipelineStageProcessor`, each concrete processor at its terminal points, and
`PipelineStageQueue` when retry exhaustion ends a lifecycle. It logs one
structured event per stage outcome at info level:
`{ invoiceId, stage, outcome, durationMs, attempt }`, with `outcome` a closed union
(`'completed' | 'skipped-stale' | 'lost-claim' | 'failed' | 'dead-letter'`). `durationMs`
comes from BullMQ's `job.processedOn` timestamp.

**Rationale.** Structured events are immediately useful in the Compose log stream and add no
transport fields to the lifecycle-critical queue payload. The e2e suite checks the event
count and privacy-safe field set across a real upload-to-`READY` run.

**Consequences.**

- Every accepted, stale, lost-claim, failed, completed, or dead-letter outcome emits one
  typed event
- An attempt that throws is reported too: the base's `@OnWorkerEvent('failed')` handler
  emits `failed` for every attempt BullMQ reports, so a stage that burns its retry budget
  leaves one `failed` event per attempt and a final `dead-letter`. What stays outside the
  events is BullMQ's own backoff interval between them
- `durationMs` is `null`, never `0`, when BullMQ reports no `processedOn` — a stage that
  finished instantly and a stage whose start is unknown must not read alike
- `outcome` values are fixed to the five named above; a new one is a type change to
  `StageOutcome` in `src/queue/stage-event.ts`, not a new string literal scattered across
  the processors and the queue
- A deployed collector or cross-process trace requirement would reopen this decision

---

## ADR-0014

### Two-key error bodies instead of RFC 9457 Problem Details

**Status:** Accepted · 2026-09-04

**Context.** `HttpExceptionFilter` normalizes application error responses to
`{ statusCode, message }`. RFC 9457 Problem Details would add
`type`/`title`/`status`/`detail` and a different media type.

**Decision.** Keep `{ statusCode, message }`. No `application/problem+json`, no `type` URI,
no `title`/`detail` fields. [`api-contract.md`](api-contract.md) §10 defines the response
contract, and the filter is the single place that produces it.

**Rationale.** The standard's additional fields are not used by the current API. It returns
fixed project messages and withholds internal error text, so `detail` would repeat
`message`, and `type` would point at documentation pages this API does not publish. The
sole client is the repository's web
application, which already validates this two-key envelope and maps statuses to localized
user messages.

**Consequences.**

- Revisit this decision if the API gains an external consumer that would benefit from a
  standard body shape
- `message` stays an application- or framework-defined fixed literal, never a caught
  error's own text; that invariant is enforced in the filter, not at each `throw`
- Clients cannot distinguish two different `400`s by body alone. Per-field detail uses the
  finding catalogue in [`api-contract.md`](api-contract.md) §7

---

## ADR-0015

### Security headers belong to the process serving the document

**Status:** Accepted · 2026-09-04 · Updated 2026-09-10

**Context.** The API applies Helmet to its proxied `/api/*` responses, while Next.js serves
the HTML document. A document CSP needs a distinct nonce for each response and Next
must receive that CSP on the forwarded request to nonce its own scripts.

**Decision.** `apps/web/proxy.ts` creates the nonce and applies the CSP to both request and
response headers. `next.config.ts` sets static document headers. The API continues to set
its response headers; the rewrite does not replace them. The source PDF is served only to its
owner as `application/pdf` with `nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Cross-Origin-Resource-Policy: same-origin`, `no-referrer`, and `no-store`, and rendering the
untrusted document is delegated to the browser-provided PDF viewer. The frame carries no
`sandbox` attribute, because the attribute blocks that viewer.

**Consequences.** Every dynamically rendered document has `script-src` and `style-src`
nonces, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and a narrow permissions policy.
An earlier revision sandboxed the PDF frame without permissions. Any `sandbox` attribute sets
the sandboxed-plugins flag, and HTML defines no token that clears it, so the frame rendered
nothing in Chrome; the response headers above, not the attribute, are what bound that
document.
`style-src 'unsafe-inline'` is needed only for Next development; production does not carry
it. The nonce disables static document optimization, which is already immaterial because the
root layout reads request headers.
The CSP carries no `upgrade-insecure-requests`. Safari applies it to `http://localhost` and
upgrades every `/_next/static` request to HTTPS, so the local stack rendered without styles or
scripts; every document resource is same-origin, so the directive adds nothing behind HTTPS
either.

---

## ADR-0016

### Browser-side reads for the review workflow

**Status:** Accepted · 2026-09-04

**Context.** The API manages the session cookie and invoice state advances asynchronously after
the page is rendered. The review UI already needs polling, stale-response guards, and local
draft state.

**Decision.** The browser reads the list, status, and review data through same-origin API
requests. It does not forward the API cookie through Server Components or use Server Actions
for this workflow.

**Consequences.** Initial data needs HTML, client JavaScript, and an API request; there is no
Server Component streaming for it. In return, cookie ownership stays at the API boundary and
an in-progress draft survives the client-side locale switch.

---

## ADR-0017

### Locale switching preserves an in-progress draft

**Status:** Accepted · 2026-09-04

**Context.** Router navigation remounts the review route and discards the correction draft.
The locale is the only route segment whose change must preserve that client state.

**Decision.** The locale control updates the URL with `history.pushState` and changes the
dictionary in place instead of navigating through Next's router.

**Consequences.** The dictionary provider updates `lang`, title, and description in the same
client effect. A future server-rendered route would need router navigation or a persisted
draft contract.

---

## ADR-0018

### Reviewer picks the VAT category; the model never guesses it

**Status:** Accepted · 2026-09-05

**Context.** A zero or exempt VAT rate needs a UNCL5305 category (`AE` reverse charge, `K`
intra-community supply, `G` export, `E` § 4 UStG exemption, `Z` zero rated) before the
generator can emit `cac:TaxCategory`/`cbc:TaxExemptionReasonCode`. The raw extraction schema
already carried `exemptionReason` (free text), but nothing could turn it into a verified
category. The model cannot see enough of the legal context to choose reliably, so the
reviewer supplies this value.

**Decision.** `VatBreakdown.category` is a closed, reviewer-only field and is not requested
in the extraction prompt (`prompt.spec.ts` asserts this), defaulting to `null` when the
key is absent so both a real model response and pre-existing stored data parse
unchanged. The review form shows a domain-language picker from
[`generation.md`](generation.md) §5.2 instead of raw UNCL5305/VATEX codes. `AE`, `K`, and
`G` imply their exemption reason code; only `E` asks for free text and reuses the existing
`exemptionReason` field.

**Consequences.** Reverse charge and the other four non-standard categories can now be
corrected through review and proceed to generation. Real KoSIT probes found two cross-field
rules: reverse charge requires the buyer's VAT ID (`BR-AE-02`, now
`mandatory.vat_category_buyer_identity`, [`validation.md`](validation.md) §5.1), and intra-community
supply (`K`) requires seller and buyer VAT IDs (`BR-IC-02`) as well as a deliver-to country
(`BR-IC-12`), satisfied from the already-mandatory buyer country rather than a new field.
This project maps no seller tax representative identifier, so its local `K` rule requires
the seller VAT ID. `L`, `M`, and `B` (Canary Islands, Ceuta/Melilla, Italian split payment)
are outside the supported invoice cases. `O` (not subject to VAT) is also excluded because
`BR-O-02` conflicts with the project's seller-identification boundary; see
[`generation.md`](generation.md) §5.2.
