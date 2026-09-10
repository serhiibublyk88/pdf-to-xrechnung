import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvoiceStatus } from '@prisma/client';
import { Client } from 'pg';
import Redis from 'ioredis';
import { LLM_PROVIDER } from '../src/data-extraction/llm-provider.interface';
import type { LlmProvider } from '../src/data-extraction/llm-provider.interface';
import { PROMPT_VERSION } from '../src/data-extraction/prompt';
import { InvoicesService } from '../src/invoices/invoices.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  GoldenFixtureSchema,
  type GoldenFixture,
} from './golden-fixture.schema';
import { addMetrics, compareFixture, type Metric } from './compare';
import { DatasetProvider } from './dataset-provider';
import { metricSource, type MetricSource } from './metric-source';
import { assertEvalQueuePrefix, assertEvalSchema } from './eval-guards';
import { interFixtureDelayMs, type EvalProviderMode } from './eval-pacing';

const apiRoot = join(__dirname, '..');
const datasetRoot = join(__dirname, 'dataset');
const METRICS_VERSION = 2;
const resultsRoot = join(__dirname, 'results');
const loadModule = createRequire(__filename);

interface SourceMetrics {
  conformance: { ready: number; valid: number };
  critical: Metric;
  important: Metric;
  lineCount: Metric;
  lineFields: Metric;
}

function emptySourceMetrics(): SourceMetrics {
  return {
    critical: { matched: 0, total: 0 },
    important: { matched: 0, total: 0 },
    lineFields: { matched: 0, total: 0 },
    lineCount: { matched: 0, total: 0 },
    conformance: { valid: 0, ready: 0 },
  };
}

function binaryVersion(command: string, arguments_: string[]): string {
  const versionCall = spawnSync(command, arguments_, { encoding: 'utf8' });
  if (versionCall.status !== 0) {
    throw new Error(`Could not read ${command} version`);
  }
  const version = `${versionCall.stdout}${versionCall.stderr}`
    .trim()
    .split('\n')[0];
  if (!version) throw new Error(`Could not read ${command} version`);
  return version;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function providerMode(): EvalProviderMode {
  const provider = argument('--provider') ?? 'dataset';
  if (
    provider === 'dataset' ||
    provider === 'gemini' ||
    provider === 'groq' ||
    provider === 'ollama'
  )
    return provider;
  throw new Error(`Unsupported evaluation provider: ${provider}`);
}

function hasAppModule(
  candidate: unknown,
): candidate is { AppModule: typeof import('../src/app.module').AppModule } {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'AppModule' in candidate
  );
}

function fixtures(only: string | undefined): GoldenFixture[] {
  const loaded = readdirSync(datasetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((directory) => {
      const source: unknown = JSON.parse(
        readFileSync(join(datasetRoot, directory, 'ground-truth.json'), 'utf8'),
      );
      return GoldenFixtureSchema.parse(source);
    });
  if (!only) return loaded;
  const fixture = loaded.find((candidate) =>
    candidate.meta.id.startsWith(only),
  );
  if (!fixture) throw new Error(`Unknown evaluation case: ${only}`);
  return [fixture];
}

async function waitForTerminal(
  prisma: PrismaService,
  invoiceId: string,
  timeoutMs = 90_000,
): Promise<InvoiceStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { status: true },
    });
    if (
      invoice.status === InvoiceStatus.READY ||
      invoice.status === InvoiceStatus.NEEDS_REVIEW ||
      invoice.status === InvoiceStatus.FAILED
    )
      return invoice.status;
    if (Date.now() > deadline)
      throw new Error(
        `Evaluation invoice ${invoiceId} did not reach a terminal status (currently ${invoice.status})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function outcome(
  status: InvoiceStatus,
): GoldenFixture['meta']['expectedOutcome'] {
  if (status === InvoiceStatus.READY) return 'success';
  if (status === InvoiceStatus.NEEDS_REVIEW) return 'needs_review';
  return 'failed';
}

interface FixtureOutcome {
  case: Record<string, unknown>;
  source: MetricSource;
  comparison: ReturnType<typeof compareFixture> | null;
  ready: boolean;
  valid: boolean;
  falseSuccess: boolean;
}

async function runFixture(
  fixture: GoldenFixture,
  {
    mode,
    prisma,
    invoices,
  }: {
    mode: EvalProviderMode;
    prisma: PrismaService;
    invoices: InvoicesService;
  },
): Promise<FixtureOutcome> {
  const startedAt = Date.now();
  const accepted = await invoices.ingest({
    ownerId: `eval-${fixture.meta.id}`,
    file: {
      buffer: readFileSync(join(datasetRoot, fixture.meta.id, 'invoice.pdf')),
      originalname: `${fixture.meta.id}.pdf`,
    },
  });
  const status = await waitForTerminal(
    prisma,
    accepted.id,
    mode === 'ollama' ? 240_000 : undefined,
  );
  const terminalInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: accepted.id },
    select: { failureCode: true, sourceType: true, textCharCount: true },
  });
  const attempt = await prisma.extractionAttempt.findFirst({
    where: { invoiceId: accepted.id },
    orderBy: { attemptNumber: 'desc' },
    select: {
      parsedData: true,
      durationMs: true,
      inputTokens: true,
      outputTokens: true,
    },
  });
  const document = await prisma.generatedDocument.findFirst({
    where: { invoiceId: accepted.id },
    select: { isValid: true },
  });
  const actualOutcome = outcome(status);
  const comparison =
    attempt?.parsedData === null || attempt?.parsedData === undefined
      ? null
      : compareFixture(fixture, attempt.parsedData);

  return {
    source: metricSource(terminalInvoice.sourceType),
    comparison,
    ready: status === InvoiceStatus.READY,
    valid: status === InvoiceStatus.READY && document?.isValid === true,
    falseSuccess:
      fixture.meta.expectedOutcome !== 'success' && actualOutcome === 'success',
    case: {
      id: fixture.meta.id,
      sourceType: terminalInvoice.sourceType,
      textCharCount: terminalInvoice.textCharCount,
      expectedOutcome: fixture.meta.expectedOutcome,
      actualOutcome,
      failureCode: terminalInvoice.failureCode,
      durationMs: Date.now() - startedAt,
      extractionDurationMs: attempt?.durationMs ?? null,
      inputTokens: attempt?.inputTokens ?? null,
      outputTokens: attempt?.outputTokens ?? null,
      mismatches: comparison?.mismatches ?? [],
    },
  };
}

function accumulate(
  metrics: Partial<Record<MetricSource, SourceMetrics>>,
  fixtureOutcome: FixtureOutcome,
): void {
  const sourceMetrics = (metrics[fixtureOutcome.source] ??=
    emptySourceMetrics());
  const { comparison } = fixtureOutcome;
  if (comparison) {
    addMetrics(sourceMetrics.critical, comparison.critical);
    addMetrics(sourceMetrics.important, comparison.important);
    addMetrics(sourceMetrics.lineFields, comparison.lineFields);
    sourceMetrics.lineCount.total += 1;
    if (comparison.lineCountMatched) sourceMetrics.lineCount.matched += 1;
  }
  if (fixtureOutcome.ready) {
    sourceMetrics.conformance.ready += 1;
    if (fixtureOutcome.valid) sourceMetrics.conformance.valid += 1;
  }
}

async function clearRedis(redisUrl: string, prefix: string): Promise<void> {
  assertEvalQueuePrefix(prefix);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}:*`,
        'COUNT',
        200,
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

async function removeSchema(
  databaseUrl: string,
  schema: string,
): Promise<void> {
  assertEvalSchema(schema);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

function removeStorage(storagePath: string): void {
  const absolutePath = resolve(storagePath);
  const allowedPrefix = `${resolve(tmpdir())}${sep}invoice-extract-eval-`;
  if (!absolutePath.startsWith(allowedPrefix)) {
    throw new Error(
      `Refusing to remove unexpected eval storage path: ${storagePath}`,
    );
  }
  rmSync(absolutePath, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const mode = providerMode();
  const engines = {
    poppler: binaryVersion('pdftocairo', ['-v']),
    tesseract: binaryVersion('tesseract', ['--version']),
  };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for evaluation');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required for evaluation');
  const runId = randomUUID().replaceAll('-', '');
  const schema = `eval_${runId}`;
  const migrationUrl = new URL(databaseUrl);
  migrationUrl.searchParams.set('schema', schema);
  const queuePrefix = `pdf-to-xrechnung:eval:${runId}`;
  let storagePath: string | undefined;
  let app: INestApplication | undefined;
  try {
    storagePath = mkdtempSync(join(tmpdir(), 'invoice-extract-eval-'));
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: migrationUrl.toString() },
      stdio: 'inherit',
    });
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = migrationUrl.toString();
    process.env.QUEUE_PREFIX = queuePrefix;
    process.env.STORAGE_PATH = storagePath;
    process.env.LLM_PROVIDER = mode === 'dataset' ? 'mock' : mode;

    const loadedModule: unknown = loadModule('../src/app.module');
    if (!hasAppModule(loadedModule)) {
      throw new Error('Evaluation could not load AppModule');
    }
    const { AppModule } = loadedModule;
    const datasetProvider = new DatasetProvider();
    const moduleBuilder = Test.createTestingModule({ imports: [AppModule] });
    if (mode === 'dataset')
      moduleBuilder.overrideProvider(LLM_PROVIDER).useValue(datasetProvider);
    const moduleFixture = await moduleBuilder.compile();
    const provider = moduleFixture.get<LlmProvider>(LLM_PROVIDER);
    if (mode === 'dataset' && provider !== datasetProvider) {
      throw new Error(
        'DatasetProvider was not installed in the evaluation module',
      );
    }
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    const prisma = app.get(PrismaService);
    const invoices = app.get(InvoicesService);
    const metrics: Partial<Record<MetricSource, SourceMetrics>> = {};
    const cases: Array<Record<string, unknown>> = [];
    const failedFixtures: string[] = [];
    let falseSuccesses = 0;
    let comparedCases = 0;

    for (const fixture of fixtures(argument('--only'))) {
      process.stdout.write(`Running ${fixture.meta.id}\n`);
      try {
        if (mode === 'dataset') datasetProvider.use(fixture);
        const fixtureOutcome = await runFixture(fixture, {
          mode,
          prisma,
          invoices,
        });
        cases.push({
          ...fixtureOutcome.case,
          providerCalls: mode === 'dataset' ? datasetProvider.calls : null,
        });
        if (fixtureOutcome.comparison) comparedCases += 1;
        if (fixtureOutcome.falseSuccess) falseSuccesses += 1;
        accumulate(metrics, fixtureOutcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedFixtures.push(fixture.meta.id);
        cases.push({ id: fixture.meta.id, error: message });
        process.stderr.write(`${fixture.meta.id} failed: ${message}\n`);
      } finally {
        if (mode === 'dataset') datasetProvider.clear();
      }
      const delayMs = interFixtureDelayMs(mode);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (failedFixtures.length > 0) {
      process.exitCode = 1;
      process.stderr.write(
        `Fixtures that did not run: ${failedFixtures.join(', ')}\n`,
      );
    }
    const report = {
      generatedAt: new Date().toISOString(),
      provider: mode,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      engines,
      cases,
      falseSuccesses,
      comparedCases,
      metrics: { bySource: metrics },
      tautological: mode === 'dataset',
      metricsVersion: METRICS_VERSION,
    };
    if (!existsSync(resultsRoot)) mkdirSync(resultsRoot, { recursive: true });
    const outputPath = join(
      resultsRoot,
      `${new Date().toISOString().slice(0, 10)}-${mode}.json`,
    );
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(report.metrics)}\nWrote ${outputPath}\n`,
    );
  } finally {
    if (storagePath) {
      const activeStoragePath = storagePath;
      const cleanupFailures: string[] = [];
      if (app) {
        try {
          await app.close();
        } catch (error) {
          cleanupFailures.push(
            `application shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const steps = [
        ['Redis keys', () => clearRedis(redisUrl, queuePrefix)],
        ['database schema', () => removeSchema(databaseUrl, schema)],
        [
          'temporary storage',
          () => Promise.resolve(removeStorage(activeStoragePath)),
        ],
      ] as const;
      for (const [step, run] of steps) {
        try {
          await run();
        } catch (error) {
          cleanupFailures.push(
            `${step}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (cleanupFailures.length > 0) {
        process.exitCode = 1;
        process.stderr.write(
          `Evaluation cleanup left state behind — ${cleanupFailures.join('; ')}\n`,
        );
      }
    }
  }
}

// Keeps the event loop alive so a stalled run hangs visibly instead of exiting 0.
const processLivenessTimer = setInterval(() => undefined, 1_000);

void main()
  .catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  })
  .finally(() => clearInterval(processLivenessTimer));
