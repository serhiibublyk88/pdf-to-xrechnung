# Local operation

The repository ships one operational target: a local Docker Compose stack that a developer
can build from a clean clone. It is not a production deployment, and it does not ship a
public service, production Compose file, Terraform, backup policy, or uptime claim.

## Runtime boundary

| Service           | Role                                      | Host port |
| ----------------- | ----------------------------------------- | --------: |
| `web`             | Next.js UI and same-origin `/api/*` proxy |      3000 |
| `api`             | NestJS HTTP server and BullMQ workers     |      3001 |
| `migrate`         | One-shot `prisma migrate deploy` gate     |         — |
| `postgres`        | Authoritative invoice state               |      5432 |
| `redis`           | BullMQ jobs and dead-letter entries       |      6379 |
| `kosit-validator` | XRechnung conformance service             |      8081 |

Every published port binds to `127.0.0.1`, so the stack is reachable only from this machine.
The database, Redis, and KoSIT ports exist for host development and tests; they are not a
production network design.

## Start the stack

Requirements: Docker with Compose.

```bash
cp apps/api/.env.example .env
docker compose up -d --build
docker compose ps
```

Open [http://localhost:3000](http://localhost:3000). Check dependencies directly with:

```bash
curl --fail http://localhost:3001/health/ready
```

The `migrate` container must exit successfully before `api` starts. PostgreSQL, Redis, and
KoSIT also have to pass their health conditions.

The default `LLM_PROVIDER=mock` requires no key. It always returns the same synthetic
invoice and is suitable only for walking through validation, review, generation, and
download. It does not read invoice values from the uploaded PDF, and the UI shows a
demo-mode notice on every page while it is active.

Useful operational commands:

```bash
docker compose logs -f api web
docker compose restart api
docker compose down
```

`docker compose down` keeps the named PostgreSQL, Redis, and upload volumes. Adding `-v`
deletes those local volumes and their data.

## Configure a real provider

`apps/api/.env.example` is the configuration reference. Change `LLM_PROVIDER` and the
matching provider values in the root `.env`, then recreate the API container so Compose
applies the new environment:

```bash
docker compose up -d --force-recreate api
```

| Provider | Required values                                          | Notes                                  |
| -------- | -------------------------------------------------------- | -------------------------------------- |
| Gemini   | `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL`  | API key is required at startup         |
| Groq     | `LLM_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL`        | API key is required at startup         |
| Ollama   | `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | The model must already exist in Ollama |

When Ollama runs on the Docker Desktop host, the API container can normally reach it at
`http://host.docker.internal:11434`. `http://127.0.0.1:11434` refers to the API container
itself and works only when the API runs directly on the host.

Provider requests use `LLM_REQUEST_TIMEOUT_MS`. A timeout, transport error, 429, or provider
5xx is retryable; malformed output receives one bounded repair attempt and then fails as a
deterministic content result. The application never switches to `MockProvider` after a live
provider failure.

## Configuration

Configuration is validated with Zod during startup. Missing credentials, malformed URLs,
unsafe production defaults, and timer overflow fail before the server listens.

| Group                   | Variables                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- |
| Process                 | `NODE_ENV`, `PORT`, `LOG_LEVEL`                                                   |
| Persistence             | `DATABASE_URL`, `REDIS_URL`, `QUEUE_PREFIX`, `STORAGE_PATH`                       |
| Providers               | `LLM_PROVIDER`, provider keys/models, `OLLAMA_BASE_URL`, `LLM_REQUEST_TIMEOUT_MS` |
| Conformance             | `KOSIT_VALIDATOR_URL`, `KOSIT_REQUEST_TIMEOUT_MS`                                 |
| Ownership and retention | `SESSION_SECRET`, `RETENTION_HOURS`, `CLEANUP_INTERVAL_MINUTES`                   |
| Input limits            | `MAX_UPLOAD_MB`, `MAX_PAGES`, `MAX_EXTRACTED_TEXT_CHARS`                          |
| OCR                     | native/OCR character thresholds, confidence threshold, and timeouts               |
| HTTP                    | `RATE_LIMIT_PER_HOUR`, `TRUSTED_PROXY_HOPS`                                       |

Compose overrides `DATABASE_URL`, `REDIS_URL`, and `KOSIT_VALIDATOR_URL` with service names.
It also runs the API as `NODE_ENV=development` because localhost uses plain HTTP and a
production session cookie is `Secure`.

`SESSION_SECRET` signs both anonymous-session cookies and review capabilities. Production
mode rejects the example secret and rejects `LLM_PROVIDER=mock`.

The Next.js `API_ORIGIN` is a build-time value. The web image receives
`http://api:3000`; the root `npm run build` command uses `http://localhost:3000` unless the
caller supplies another origin. Changing it only at container runtime does not change the
compiled rewrite.

## Host development

Node.js 22 or newer is required. The API host also needs Poppler, Tesseract, and German
Tesseract language data.

Compose reads the root `.env` even when it starts only the dependencies, and the host API
reads `apps/api/.env` from its own directory. Create both from the example, start the
dependencies in Docker, and prepare the API:

```bash
cp apps/api/.env.example .env
cp apps/api/.env.example apps/api/.env
docker compose up -d postgres redis kosit-validator
npm ci
cd apps/api
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

`npm ci` builds only the shared contracts package, so `npx prisma generate` is required
before the API can typecheck, test, or start. The host API listens on port 3000 and keeps
its database, Redis, KoSIT, and Ollama URLs on localhost.

Run the web application from another shell on port 3100. Its `API_ORIGIN` defaults to the
host API at `http://localhost:3000`:

```bash
npm run dev -w apps/web -- -p 3100
```

### Browser tests

The Playwright suite starts its own Next.js dev server on port 3100 and calls the host API
on port 3000. The review-flow test seeds PostgreSQL directly, so it needs `DATABASE_URL`:

```bash
cd apps/web
npx playwright install chromium
DATABASE_URL=postgresql://pdf_to_xrechnung:pdf_to_xrechnung@localhost:5432/pdf_to_xrechnung \
  npm run test:e2e
```

To run it against the Compose stack instead, set `PLAYWRIGHT_BASE_URL=http://localhost:3000`
and `API_ORIGIN=http://localhost:3001`, as the `docker-build` CI job does.

## Health and logs

- `GET /health/live` reports whether the process can answer HTTP.
- `GET /health/ready` probes PostgreSQL, Redis, and KoSIT in parallel and returns `503`
  with the status of each dependency when any probe fails.
- Pino emits structured JSON in production and readable logs in development.
- Logs may contain a technical invoice ID where operational correlation needs it. They do
  not contain invoice text, raw provider output, owner identifiers, filenames, or extracted
  business values.

Metrics and tracing are not included because the project has no deployed target. Queue and
dead-letter state is available through the owner-scoped diagnostic flow; stage-completion
logs include duration and provider metadata.

## Data lifecycle

Uploads live in the `api-storage` volume. Invoice rows, extracted text, provider responses,
reviewed values, generated XML, and KoSIT reports become inaccessible at `expiresAt` and are
eligible for the next cleanup sweep, normally after two hours.

Stopping the stack pauses cleanup; it does not delete volumes. The synthetic eval corpus is
repository data and runs in an isolated PostgreSQL schema and storage directory.

## CI

GitHub Actions runs five jobs:

| Job            | Checks                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| `lint`         | workspace lint, unused-code scan, and fixture validation                      |
| `typecheck`    | strict TypeScript across contracts, API, and web                              |
| `test`         | unit, integration, and e2e suites with real PostgreSQL, Redis, and KoSIT      |
| `build`        | production builds and required API runtime assets                             |
| `docker-build` | both images, Compose readiness, bundle budget, and production Playwright flow |

Live Gemini, Groq, and Ollama evals remain manual because remote calls consume quota and
their output is not deterministic. Dated reports are committed after review.

## Troubleshooting

**A published port is already in use.** `docker compose up` fails to bind `3000`, `3001`,
`5432`, `6379`, or `8081`. Find the process with `lsof -nP -iTCP:3000 -sTCP:LISTEN`, stop it,
or change the host side of the mapping in `docker-compose.yml`.

**`api` never starts.** It waits for `postgres`, `redis`, and `kosit-validator` to report
healthy and for `migrate` to exit successfully. `docker compose ps` shows which condition is
unmet; `curl --fail http://localhost:3001/health/ready` names the failing dependency once the
API is up.

**`migrate` exits non-zero.** The API stays down by design. Read `docker compose logs migrate`;
it names the migration and the database error. Fix the cause it reports. Resetting local data
is a separate, deliberate step: `docker compose down -v` deletes the PostgreSQL, Redis, and
upload volumes with everything in them, so use it only when you intend to start from empty.

**KoSIT is slow on the first start.** The validator loads its configuration before reporting
healthy, so `api` can wait noticeably longer on a cold first run than on later ones. Follow
`docker compose logs -f kosit-validator` rather than restarting the stack.

**The API container cannot reach Ollama.** Inside the container `http://127.0.0.1:11434` is
the container itself, not the host. On Docker Desktop use
`http://host.docker.internal:11434`. On native Docker Engine for Linux that name is not
defined by default: point
`OLLAMA_BASE_URL` at an address the container can reach, or add an `extra_hosts` entry for it.

**The frontend calls the wrong API.** `API_ORIGIN` is compiled into the web build, so changing
it only at container runtime has no effect. Rebuild the `web` image after changing it.
