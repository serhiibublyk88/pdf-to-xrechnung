# Evaluation

This document owns the eval corpus, the scoring rules, and the measured provider results.

## 1. Why evals exist

A successful JSON response only confirms that the provider integration responds. The eval
suite checks the extracted values against the PDF, verifies refusal cases, and validates
generated documents with KoSIT.

It also serves two practical needs:

- Prompt changes can improve one field and break another. Dated baselines make that visible.
- Debugging and measurement use synthetic data, so no user data is
  retained for evaluation. See [`PROJECT.md`](PROJECT.md#data-handling-and-privacy).

## 2. Dataset

The dataset is committed under `apps/api/evals/dataset/` and is not subject to invoice
retention.

The corpus contains eighteen fixtures: thirteen native-text cases and five image-only OCR
cases. Each `ground-truth.json` uses the raw-extraction shape from
[`extraction.md`](extraction.md) §3, including explicit nulls. Run
`npm run eval:validate` to validate schema, completeness metadata, line
arithmetic, VAT groups, totals, and the rendered PDF: critical values must remain in each
native text layer, while every scan page must remain below the native-text threshold. CI
runs the same command. The measured baselines are stored in `apps/api/evals/results/`.

```
apps/api/evals/
  templates/                    HTML layouts for the native cases
  render.ts                     Playwright renderer
  dataset/
    001-clean-de/
      invoice.pdf
      ground-truth.json
    002-clean-en/
    ...
  results/                      timestamped evaluation reports
  run.ts                        isolated full-pipeline runner
```

### 2.1 Corpus

Every fixture covers a distinct input or failure mode. Cases 11, 12, 16, 17, and 18 are
scans, so OCR metrics remain separate from the native-text baseline.

|   # | Case                                                  | What it exercises                        |
| --: | ----------------------------------------------------- | ---------------------------------------- |
|   1 | Simple German invoice, one page, one VAT rate         | Baseline                                 |
|   2 | English invoice from an international supplier        | Language independence                    |
|   3 | Multi-page invoice with lines across a page break     | Page assembly                            |
|   4 | Mixed 19% and 7% VAT                                  | VAT breakdown                            |
|   5 | Zero-rated or exempt supply                           | Exemption handling                       |
|   6 | Document-level discount                               | Known arithmetic boundary                |
|   7 | More than 30 line items                               | Context length and line accuracy         |
|   8 | Kleinbetragsrechnung                                  | Sparse buyer data still blocks XRechnung |
|   9 | Totals outside the conventional bottom-right position | Layout variation                         |
|  10 | Repeated header and footer content                    | Noise tolerance                          |
|  11 | Image-only version of case 1                          | Clean OCR comparison                     |
|  12 | Degraded image-only invoice                           | OCR degradation                          |
|  13 | Foreign currency                                      | Currency handling                        |
|  14 | Long free-text descriptions                           | Truncation                               |
|  15 | A contract rather than an invoice                     | Correct refusal                          |
|  16 | Image-only PDF with no usable content                 | Explicit OCR failure                     |
|  17 | Two-page image-only invoice                           | OCR page assembly and budget             |
|  18 | Illegible image-only invoice                          | OCR confidence rejection                 |

Cases 15, 16, and 18 measure refusal behaviour and are scored on the terminal outcome, not
field accuracy. Case 16 covers an unusable scan, case 17 covers multi-page OCR assembly,
and case 18 covers low-confidence rejection.

### 2.2 Generating the dataset

Only synthetic invoices belong in this dataset. Real invoices contain personal and
commercial data and must not be committed.

Ground truth is written as a typed `GoldenFixture`, and the PDF is rendered from it. The
`party()` helper in `generate-golden-set.ts` keeps explicit nulls readable. The generator
does not derive expected values from the rendered PDF.

**Rendering** goes through Playwright:

- `apps/api/evals/templates/*.html`: several layouts, including conventional, compact,
  middle-of-page totals, and repeating header/footer variants. Cases 9 and 10 cover these
  layout differences.
- `apps/api/evals/render.ts`: `page.pdf()` for the native cases. For scans,
  `page.screenshot({ type: 'jpeg' })`; a degraded case applies grayscale, `contrast(0.78)`,
  `blur(0.35px)`, and a `rotate(-0.2deg)` transform before the JPEG is wrapped in a PDF as
  a `/Filter /DCTDecode` image XObject. Image dimensions come from the configured viewport,
  so nothing parses the JPEG. Scan PDF pages use A4 dimensions independently of their
  1240 × 1754 source pixels, matching a 300-DPI scan rather than treating image pixels as
  PDF points. The degraded scan models a low-quality photocopy without simulating a
  perspective-distorted phone photo.
- Dataset generation is a manual local step whose output is committed. CI runs
  `eval:validate` against those committed files and never regenerates them.

`eval:validate` runs every native PDF through `NativeTextExtractor` and requires each
critical value from the ground truth to appear in the extracted text. This covers invoice
number, dates, totals, VAT rates, and line amounts. CI fails if a template stops printing
one of them.

### 2.3 Ground truth format

The ground truth uses the extraction schema from [`extraction.md`](extraction.md) §3, plus
metadata:

```json
{
  "meta": {
    "id": "004-mixed-vat-de",
    "language": "de",
    "sourceType": "native",
    "content": "invoice",
    "pages": 1,
    "expectedOutcome": "success",
    "expectedErrors": [],
    "notes": "19% and 7% on the same invoice"
  },
  "data": { "invoiceNumber": "RE-2026-0042", "...": "..." }
}
```

`expectedOutcome` is one of `success`, `needs_review`, `failed`. The enum is enforced by
`apps/api/evals/golden-fixture.schema.ts`; §3.3 uses the same three names.
An OCR fixture must also declare `scanQuality` as `clean`, `degraded`, `illegible` or
`blank`; native fixtures must not declare it. The renderer therefore cannot turn an
omitted OCR quality into a clean scan.

`content` says what the page depicts: `invoice` or `not-an-invoice`. It is not inferred
from `expectedOutcome`, because an invoice can be expected to fail for another reason
(`016` is blank and `018` is illegible). The renderer must still draw an invoice for it.

## 3. Metrics

### 3.1 Field-level accuracy

For each scalar field: exact match after normalisation.

- Money compared in integer cents
- Strings compared case-insensitively with whitespace collapsed
- `null` must match `null`: a hallucinated value where the invoice has nothing is a
  failure, not a near-miss

Reported per group, per `sourceType`:

| Group      | Fields                                                                        | Target |
| ---------- | ----------------------------------------------------------------------------- | ------ |
| Critical   | `invoiceNumber`, `issueDate`, `netTotal`, `vatTotal`, `grossTotal`, VAT rates | ≥ 98%  |
| Important  | seller/buyer identity, `vatId`, `iban`                                        | ≥ 95%  |
| Line items | see §3.2                                                                      | ≥ 90%  |

Reports separate native and OCR results. A source column appears only when that source was
actually evaluated; an empty or dashed column would be ambiguous with a measured zero.

### 3.2 Line-item accuracy

Line-item counts and fields are reported separately:

- Count match: extracted line count equals expected, binary per invoice
- Field accuracy: positional, over `min(expected, actual)` lines
- Separate reporting prevents 3 correct lines out of 8 from appearing as 100% accuracy

Matching is positional because line order and the invoice line identifier carry meaning in
XRechnung. Best-match scoring would hide ordering errors.

Strings are compared exactly after normalisation, with no fuzzy scoring. A similarity
score does not say whether the description matches the source document.

### 3.3 Outcome accuracy

Per invoice, did the system reach the expected state?

| Expected       | Meaning                                           |
| -------------- | ------------------------------------------------- |
| `success`      | Reached `READY` with valid XML                    |
| `needs_review` | Correctly flagged for review                      |
| `failed`       | Correctly refused (not an invoice, unusable scan) |

A false `success` means incorrect data was presented as correct. It is tracked separately
and reported even when the count is zero.

### 3.4 Conformance

Of invoices reaching `READY`, the share whose XML passes KoSIT with zero errors.
Target: 100%. A lower result indicates a mapping or conformance-handling defect.

### 3.5 Operational

Recorded but not targeted, per invoice: total duration, the extraction-call
duration, and input/output token usage. Retry rate and cache-hit rate are not
currently recorded anywhere in the harness.

## 4. Runner

```bash
npm run eval                       # full set with DatasetProvider
npm run eval -- --provider dataset # deterministic, CI — verifies the harness, not a model
npm run eval -- --provider gemini  # manual live-provider baseline
npm run eval -- --provider groq    # manual live-provider baseline
npm run eval -- --provider ollama  # manual local-provider baseline
npm run eval -- --only 004         # single case while iterating
```

Behaviour:

1. Reset a dedicated eval database
2. Run each invoice through the complete application pipeline
3. Compare against ground truth
4. Write a timestamped report to `apps/api/evals/results/`
5. Print a summary table
6. Preserve all measured metrics, including provider failures and mismatches

The runner includes queueing, persistence, validation, generation, and KoSIT instead of
calling the provider in isolation.

Gemini and Groq runs wait 60 seconds between fixtures. This is part of measurement
isolation, not application retry policy. Without the delay, a shared token window can turn
the rest of the report into quota failures. Dataset and Ollama runs have no artificial
delay.

The deterministic run replaces only the LLM boundary with an eval-local
`DatasetProvider`. Production code never reads `evals/dataset/`, while the rest of the
application starts normally and uses the same persistence, queue, validation, generation,
and KoSIT path.

`DatasetProvider` receives the current fixture before upload, and the runner processes
cases sequentially. Nothing parses the prompt or matches on invoice number because exactly
one case is ever in flight. Sequential
execution is also what makes §3.5's duration figures meaningful.

Run isolation reuses the recipe in `apps/api/test/jest-e2e-global-setup.ts`: a unique
database schema with `prisma migrate deploy`, its own `QUEUE_PREFIX`, and its own
`STORAGE_PATH` under the system temporary directory.

Case 16 (unusable scan) fails before data extraction, so the provider is never called for
it. That absence is the expected result, not a runner fault.

`DatasetProvider` field-accuracy numbers are not a model measurement. It echoes each
fixture's `ground-truth.json` back as the "extraction," so comparison against that file
always scores 100%. A `--provider dataset` report's `tautological: true` flag exists so
nothing downstream mistakes it for a model result. It verifies that the harness runs end
to end, not provider accuracy.

`metricsVersion` identifies the exact field tiers behind each denominator. It must change
whenever a field joins a tier or moves between tiers; reports with different versions are
not directly comparable. Fixture count is recorded separately because refusal cases can
change outcome coverage without changing a field denominator.

### 4.1 In CI

`eval:validate` verifies all 18 committed fixtures: native PDFs retain their text layer,
and scan PDFs do not accidentally retain one. The full set with `DatasetProvider` covers
parsing, validation, and XML mapping without a
model request. CI does not regenerate the dataset: the PDFs are generated locally and
committed.

Runs against a real provider are manual, because they cost quota and are not
reproducible. Their results are committed by hand with the model and date recorded.

## 5. Reporting

The README summarizes the current results.

The current live-provider reports are the three dated `2026-09-09` files in
`apps/api/evals/results/`. Each ran the same 18 fixtures and prompt `v5` through the
complete pipeline with Poppler 26.06.0 and Tesseract 5.5.2, with no dataset-provider
substitution. The local Ollama run,
[`2026-09-09-ollama.json`](../apps/api/evals/results/2026-09-09-ollama.json), used
`qwen3.8:27b-mlx`:

```
Extraction accuracy — Ollama, measured 2026-09-09

                    native             OCR
critical fields     117 / 117 (100.0%)  27 / 27 (100.0%)
important fields    401 / 403 (99.5%)   85 / 93 (91.4%)
line items          367 / 368 (99.7%)   24 / 24 (100.0%)
line count match     13 / 13 (100.0%)    3 / 3 (100.0%)

conformance (KoSIT)     9 / 9             2 / 2
false success              0
```

Sixteen of eighteen terminal outcomes matched expectation. `002-clean-en` and
`012-scan-degraded-de` reached `NEEDS_REVIEW` instead of `READY`; the blank and illegible
scans failed at their OCR quality boundaries, and the not-an-invoice case
failed with no usable invoice data. Every document that reached `READY` passed KoSIT.

### 5.1 Live-provider comparison

| Provider / model               | Report                                                                       | Expected outcomes |  Critical | Important | Line fields | KoSIT valid / ready | False success |
| ------------------------------ | ---------------------------------------------------------------------------- | ----------------: | --------: | --------: | ----------: | ------------------: | ------------: |
| Ollama `qwen3.8:27b-mlx`       | [`2026-09-09-ollama.json`](../apps/api/evals/results/2026-09-09-ollama.json) |           16 / 18 | 144 / 144 | 486 / 496 |   391 / 392 |             11 / 11 |             0 |
| Gemini `gemini-3.5-flash-lite` | [`2026-09-09-gemini.json`](../apps/api/evals/results/2026-09-09-gemini.json) |           16 / 18 | 144 / 144 | 485 / 496 |   391 / 392 |             11 / 11 |             0 |
| Groq `openai/gpt-oss-20b`      | [`2026-09-09-groq.json`](../apps/api/evals/results/2026-09-09-groq.json)     |           15 / 18 | 144 / 144 | 483 / 496 |   391 / 392 |             10 / 10 |             0 |

"Expected outcomes" counts the three intended refusals as matches when they fail as
designed; every provider refused all three. `002-clean-en` and `012-scan-degraded-de`
required review with every provider. Groq also sent `011-scan-clean-de` to review, so it
produced one `READY` document fewer and KoSIT validated ten. The source-specific metrics and
per-field mismatches remain in the dated JSON reports.

Strong results do not make a synthetic baseline representative. These reports establish a
baseline for this corpus and do not predict OCR accuracy on noisy real invoices. Provider
failures and regressions remain in the denominator.

## 6. Baselines and change control

- Dated complete runs are immutable baselines; new runs are added as separate reports
- Any prompt change bumps `promptVersion` and requires a fresh run
- Every report records the prompt version alongside provider, model and OCR engine versions
- Model or provider changes are recorded with results
- CI (`.github/workflows/ci.yml`) runs `eval:validate` (dataset-fixture
  shape, §4.1); nothing compares a new run's field-accuracy metrics against the
  committed baseline or blocks a merge on a regression. That comparison is manual

## 7. Limitations

- 18 invoices in the baseline; this is still a small sample and the percentages carry wide
  error bars
- Synthetic invoices are cleaner than many real ones, so these results do not predict
  real-world accuracy
- Synthetic scans are milder than real scans
- Ground truth is hand-written and may contain errors, although §2.2's extraction
  check catches the case where the rendered PDF and the truth disagree

## 8. Further measurement

The release does not depend on scheduled provider calls or a larger corpus. Those additions
should follow concrete new invoice shapes or a need to compare model changes, because live
runs consume quota and introduce provider-side variability. The remaining measurement
follow-ups are tracked in [`roadmap.md`](roadmap.md).
