# Roadmap

This file is the source of truth for project status.

## Current status

| Area                             | Status | Evidence                                             |
| -------------------------------- | ------ | ---------------------------------------------------- |
| PDF ingestion and native text    | Done   | API integration and e2e suites                       |
| OCR fallback and resource bounds | Done   | OCR unit, integration, and real-runtime probes       |
| LLM extraction                   | Done   | Gemini, Groq, Ollama, and schema-boundary tests      |
| Deterministic validation         | Done   | 65-rule catalogue and exact-decimal tests            |
| XRechnung generation             | Done   | Mapping e2e tests against KoSIT                      |
| Review UI                        | Done   | Vitest and production Playwright flow                |
| Queue recovery and retention     | Done   | Real PostgreSQL/Redis integration and e2e suites     |
| Eval harness                     | Done   | 18 fixtures and three complete live-provider reports |
| Backend and frontend audit       | Done   | Full repository gate completed 2026-09-07            |
| Public documentation             | Done   | Plain-language, link, and claim review               |
| Portfolio walkthrough            | Done   | Screenshots in the README                            |

The application scope is complete.

## Completed scope

- PDF input with native-text extraction and OCR fallback
- Gemini, Groq, local Ollama, and a credential-free deterministic demo provider
- PostgreSQL-owned lifecycle state with recoverable Redis work
- Conditional transitions scoped by invoice ID, storage key, status, and expiry
- Deterministic validation, correction, XRechnung UBL generation, and KoSIT conformance
- German and English review UI
- Two-hour access window, periodic cleanup, owner isolation, rate limits, and no-store
  invoice responses
- Docker Compose startup, CI, and separate unit/integration/e2e test layers
- Synthetic native/OCR eval corpus with measured refusal behaviour

The complete prompt-v5 comparison of Ollama, Gemini, and Groq is recorded in
[`evals.md`](evals.md).

## Non-blocking follow-ups

These would improve measurement but do not block the portfolio release:

- Record the number of provider attempts in future eval reports; current live reports leave
  `providerCalls` as `null`.
- Probe each remote provider once with invalid credentials to record its live
  authentication error classification.
- Expand the synthetic corpus when a new invoice shape exposes a concrete blind spot.
- Decide whether periodic real-provider runs are worth their quota and nondeterminism; CI
  currently validates the corpus and deterministic pipeline only.

## Non-goals

- Hosted public demo
- Accounts, multi-tenancy, billing, and ERP integration
- ZUGFeRD output
- Image-file and phone-photo input
- External VAT/address lookups
- S3, horizontal scaling, and high-availability deployment

The reasons and resulting guarantees are documented in [`PROJECT.md`](PROJECT.md).
[`operations.md`](operations.md) documents the local stack that is delivered.

## Release check

A release is ready when a reader with only the repository can:

1. understand the product boundary and measured limitations from the README;
2. start the credential-free stack from a clean clone;
3. configure a real provider from the tracked documentation;
4. trace the lifecycle, HTTP, validation, and conformance contracts through the docs.
