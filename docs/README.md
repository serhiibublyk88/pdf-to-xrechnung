# Documentation

Start with the root [`README`](../README.md) to run the application and see the measured
provider results. Use this directory when you need the contract behind a subsystem.

## Reading paths

For product context:

1. [`PROJECT.md`](PROJECT.md): scope, guarantees, and limitations
2. [`architecture.md`](architecture.md): runtime flow, state transitions, and recovery
3. [`architecture-decisions.md`](architecture-decisions.md): accepted trade-offs

For backend work:

1. [`api-contract.md`](api-contract.md): HTTP shapes, status codes, limits, and rule codes
2. [`data-model.md`](data-model.md): persistence, lifecycle state, retention, and deduplication
3. [`extraction.md`](extraction.md): PDF/OCR boundaries and provider output validation
4. [`validation.md`](validation.md): deterministic invoice rules and review routing
5. [`generation.md`](generation.md): UBL mapping and KoSIT validation

For operation and measurement:

- [`operations.md`](operations.md): running the local stack, configuration, and CI
- [`evals.md`](evals.md): fixture design, scoring, runner behaviour, and real-provider results
- [`roadmap.md`](roadmap.md): current status and follow-ups

## Sources of truth

| Subject                            | Owner                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Project status                     | [`roadmap.md`](roadmap.md)                                                     |
| Database structure                 | [`../apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma)         |
| Shared wire schemas and code lists | [`../packages/contracts/src/`](../packages/contracts/src/)                     |
| HTTP behaviour                     | [`api-contract.md`](api-contract.md)                                           |
| Extraction metrics                 | Dated JSON files in [`../apps/api/evals/results/`](../apps/api/evals/results/) |

These documents describe the delivered local stack; production deployment is outside the
project scope. Generated schemas remain in code.
