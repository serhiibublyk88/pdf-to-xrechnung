import { z } from 'zod';

const DEVELOPMENT_SESSION_SECRET =
  'development-session-secret-not-for-production';
const EXAMPLE_FILE_SESSION_SECRET =
  'replace-with-a-random-secret-of-at-least-32-characters';
export const DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE = 50;
export const DEFAULT_OCR_MIN_MEAN_CONFIDENCE = 80;

// Node's timers silently overflow past a 32-bit signed int; AbortSignal.timeout degrades the same way.
const MAX_TIMER_MS = 2_147_483_647;

const POSTGRES_RESERVED_SCHEMA_PREFIX = /^pg_/i;
const POSTGRES_RESERVED_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

export function isLegalPostgresSchemaName(name: string): boolean {
  if (name.length < 1 || name.length > 63) {
    return false;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return false;
  }
  if (POSTGRES_RESERVED_SCHEMA_PREFIX.test(name)) {
    return false;
  }
  return !POSTGRES_RESERVED_SCHEMAS.has(name.toLowerCase());
}

function coerceNumeric(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() === '' ? NaN : Number(value);
}

function numeric<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(coerceNumeric, schema);
}

function nonBlankString(schema: z.ZodString) {
  return schema.refine((value) => value.trim().length > 0, {
    message: 'must not be empty or made only of whitespace',
  });
}

function serviceUrl(
  schemes: readonly string[],
  options: {
    allowUserinfo?: boolean;
    validate?: (parsed: URL, ctx: z.RefinementCtx) => void;
  } = {},
) {
  const { allowUserinfo = true, validate } = options;
  return z.string().superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `must be a valid URL using ${schemes.join(' or ')}`,
      });
      return;
    }
    if (!schemes.includes(parsed.protocol)) {
      ctx.addIssue({
        code: 'custom',
        message: `must use ${schemes.join(' or ')}, not ${parsed.protocol}`,
      });
    }
    if (!allowUserinfo && (parsed.username || parsed.password)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must not include a username or password',
      });
    }
    validate?.(parsed, ctx);
  });
}

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: numeric(z.number().int().positive().max(65535).default(3000)),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: serviceUrl(['postgres:', 'postgresql:'], {
    validate: (parsed, ctx) => {
      const schemaParam = parsed.searchParams.get('schema');
      if (schemaParam !== null && !isLegalPostgresSchemaName(schemaParam)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'schema query parameter must be a legal PostgreSQL schema name',
        });
      }
    },
  }),
  REDIS_URL: serviceUrl(['redis:', 'rediss:']),
  QUEUE_PREFIX: nonBlankString(z.string()).default('pdf-to-xrechnung'),

  LLM_PROVIDER: z.enum(['mock', 'gemini', 'groq', 'ollama']).default('mock'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: nonBlankString(z.string()).default('gemini-3.5-flash'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: nonBlankString(z.string()).default('openai/gpt-oss-20b'),
  OLLAMA_BASE_URL: serviceUrl(['http:', 'https:'], {
    allowUserinfo: false,
  }).default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: nonBlankString(z.string()).default('qwen3.8:27b-mlx'),
  LLM_REQUEST_TIMEOUT_MS: numeric(
    z.number().int().positive().max(MAX_TIMER_MS).default(30_000),
  ),

  STORAGE_PATH: nonBlankString(z.string()).default('./data/uploads'),
  RETENTION_HOURS: numeric(z.number().positive().default(2)),
  SESSION_SECRET: nonBlankString(z.string().min(32)).default(
    DEVELOPMENT_SESSION_SECRET,
  ),
  CLEANUP_INTERVAL_MINUTES: numeric(z.number().positive().default(10)),
  MAX_UPLOAD_MB: numeric(z.number().positive().default(10)),
  MAX_PAGES: numeric(z.number().int().positive().default(30)),
  RATE_LIMIT_PER_HOUR: numeric(z.number().int().positive().default(20)),
  TRUSTED_PROXY_HOPS: numeric(z.number().int().nonnegative().max(2).default(0)),

  NATIVE_TEXT_MIN_CHARS_PER_PAGE: numeric(
    z.number().positive().default(DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE),
  ),
  OCR_MIN_CHARS_PER_PAGE: numeric(z.number().positive().default(50)),
  NATIVE_TEXT_TIMEOUT_MS: numeric(
    z.number().int().positive().max(MAX_TIMER_MS).default(30_000),
  ),
  OCR_MIN_MEAN_CONFIDENCE: numeric(
    z.number().min(0).max(100).default(DEFAULT_OCR_MIN_MEAN_CONFIDENCE),
  ),
  OCR_TIMEOUT_MS: numeric(z.number().int().positive().default(15_000)),
  MAX_EXTRACTED_TEXT_CHARS: numeric(
    z.number().int().positive().default(500_000),
  ),

  KOSIT_VALIDATOR_URL: serviceUrl(['http:', 'https:'], {
    allowUserinfo: false,
  }),
  KOSIT_REQUEST_TIMEOUT_MS: numeric(
    z.number().int().positive().max(MAX_TIMER_MS).default(30_000),
  ),
});

const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['GEMINI_API_KEY'],
      message: 'GEMINI_API_KEY is required when LLM_PROVIDER=gemini',
    });
  }
  if (env.LLM_PROVIDER === 'groq' && !env.GROQ_API_KEY?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['GROQ_API_KEY'],
      message: 'GROQ_API_KEY is required when LLM_PROVIDER=groq',
    });
  }
  if (
    env.NODE_ENV === 'production' &&
    (env.SESSION_SECRET === DEVELOPMENT_SESSION_SECRET ||
      env.SESSION_SECRET === EXAMPLE_FILE_SESSION_SECRET)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_SECRET'],
      message: 'SESSION_SECRET must be set in production',
    });
  }
  if (env.NODE_ENV === 'production' && env.LLM_PROVIDER === 'mock') {
    ctx.addIssue({
      code: 'custom',
      path: ['LLM_PROVIDER'],
      message:
        'LLM_PROVIDER must not be mock in production: it fabricates the same invoice for every input',
    });
  }
  if (env.OCR_TIMEOUT_MS * env.MAX_PAGES > MAX_TIMER_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['OCR_TIMEOUT_MS'],
      message: `OCR_TIMEOUT_MS * MAX_PAGES must not exceed ${MAX_TIMER_MS}`,
    });
  }
  if (env.CLEANUP_INTERVAL_MINUTES * 60_000 > MAX_TIMER_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['CLEANUP_INTERVAL_MINUTES'],
      message: `CLEANUP_INTERVAL_MINUTES * 60000 must not exceed ${MAX_TIMER_MS}`,
    });
  }
});

export type Env = z.infer<typeof baseEnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsedEnv = envSchema.safeParse(raw);
  if (!parsedEnv.success) {
    const issues = parsedEnv.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsedEnv.data;
}
