import { isLegalPostgresSchemaName, validateEnv } from './env.schema';

function baseEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    KOSIT_VALIDATOR_URL: 'http://localhost:8081',
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('defaults LLM_PROVIDER to mock without requiring an API key', () => {
    expect(() => validateEnv(baseEnv())).not.toThrow();
  });

  it('defaults and bounds the OCR settings', () => {
    expect(validateEnv(baseEnv())).toMatchObject({
      OCR_MIN_CHARS_PER_PAGE: 50,
      OCR_MIN_MEAN_CONFIDENCE: 80,
      OCR_TIMEOUT_MS: 15_000,
    });
    expect(() =>
      validateEnv(baseEnv({ OCR_MIN_MEAN_CONFIDENCE: 101 })),
    ).toThrow('OCR_MIN_MEAN_CONFIDENCE');
    expect(() => validateEnv(baseEnv({ OCR_TIMEOUT_MS: 0 }))).toThrow(
      'OCR_TIMEOUT_MS',
    );
    expect(() => validateEnv(baseEnv({ OCR_MIN_CHARS_PER_PAGE: 0 }))).toThrow(
      'OCR_MIN_CHARS_PER_PAGE',
    );
  });

  it('rejects LLM_PROVIDER=gemini without GEMINI_API_KEY', () => {
    expect(() => validateEnv(baseEnv({ LLM_PROVIDER: 'gemini' }))).toThrow(
      'GEMINI_API_KEY is required when LLM_PROVIDER=gemini',
    );
  });

  it('accepts LLM_PROVIDER=gemini with GEMINI_API_KEY set', () => {
    expect(() =>
      validateEnv(
        baseEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' }),
      ),
    ).not.toThrow();
  });

  it('rejects LLM_PROVIDER=groq without GROQ_API_KEY', () => {
    expect(() => validateEnv(baseEnv({ LLM_PROVIDER: 'groq' }))).toThrow(
      'GROQ_API_KEY is required when LLM_PROVIDER=groq',
    );
  });

  it('accepts LLM_PROVIDER=groq with GROQ_API_KEY set', () => {
    expect(() =>
      validateEnv(baseEnv({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'test-key' })),
    ).not.toThrow();
  });

  it('accepts LLM_PROVIDER=ollama without an API key', () => {
    expect(() =>
      validateEnv(baseEnv({ LLM_PROVIDER: 'ollama' })),
    ).not.toThrow();
  });

  it('rejects a missing KOSIT_VALIDATOR_URL rather than defaulting to localhost', () => {
    const envWithoutKosit = baseEnv();
    delete envWithoutKosit.KOSIT_VALIDATOR_URL;
    expect(() => validateEnv(envWithoutKosit)).toThrow('KOSIT_VALIDATOR_URL');
  });

  it('rejects the development session secret in production', () => {
    expect(() => validateEnv(baseEnv({ NODE_ENV: 'production' }))).toThrow(
      'SESSION_SECRET must be set in production',
    );
  });

  it('rejects the .env.example placeholder session secret in production', () => {
    expect(() =>
      validateEnv(
        baseEnv({
          NODE_ENV: 'production',
          SESSION_SECRET:
            'replace-with-a-random-secret-of-at-least-32-characters',
        }),
      ),
    ).toThrow('SESSION_SECRET must be set in production');
  });

  it('accepts an explicit session secret and a real provider in production', () => {
    expect(() =>
      validateEnv(
        baseEnv({
          NODE_ENV: 'production',
          SESSION_SECRET:
            'a-session-secret-that-is-long-enough-to-sign-cookies',
          LLM_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'test-key',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects the mock LLM provider in production', () => {
    expect(() =>
      validateEnv(
        baseEnv({
          NODE_ENV: 'production',
          SESSION_SECRET:
            'a-session-secret-that-is-long-enough-to-sign-cookies',
        }),
      ),
    ).toThrow('LLM_PROVIDER must not be mock in production');
  });

  it('accepts the mock LLM provider outside production', () => {
    expect(() =>
      validateEnv(baseEnv({ NODE_ENV: 'development' })),
    ).not.toThrow();
  });

  describe('URL protocol boundaries', () => {
    it('rejects a non-PostgreSQL scheme for DATABASE_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({ DATABASE_URL: 'http://user:pass@localhost:5432/db' }),
        ),
      ).toThrow('DATABASE_URL');
    });

    it('accepts both legal PostgreSQL schemes for DATABASE_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' }),
        ),
      ).not.toThrow();
      expect(() =>
        validateEnv(
          baseEnv({
            DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
          }),
        ),
      ).not.toThrow();
    });

    it('rejects a non-Redis scheme for REDIS_URL', () => {
      expect(() =>
        validateEnv(baseEnv({ REDIS_URL: 'https://localhost:6379' })),
      ).toThrow('REDIS_URL');
    });

    it('accepts both legal Redis schemes for REDIS_URL', () => {
      expect(() =>
        validateEnv(baseEnv({ REDIS_URL: 'redis://localhost:6379' })),
      ).not.toThrow();
      expect(() =>
        validateEnv(baseEnv({ REDIS_URL: 'rediss://localhost:6379' })),
      ).not.toThrow();
    });

    it('rejects a non-HTTP scheme for KOSIT_VALIDATOR_URL', () => {
      expect(() =>
        validateEnv(baseEnv({ KOSIT_VALIDATOR_URL: 'ftp://localhost:8081' })),
      ).toThrow('KOSIT_VALIDATOR_URL');
    });

    it('rejects userinfo in KOSIT_VALIDATOR_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({
            KOSIT_VALIDATOR_URL: 'http://user:pass@localhost:8081',
          }),
        ),
      ).toThrow('KOSIT_VALIDATOR_URL');
    });

    it('rejects userinfo in OLLAMA_BASE_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({ OLLAMA_BASE_URL: 'http://user:pass@localhost:11434' }),
        ),
      ).toThrow('OLLAMA_BASE_URL');
    });

    it('accepts a legal https KOSIT_VALIDATOR_URL without userinfo', () => {
      expect(() =>
        validateEnv(
          baseEnv({ KOSIT_VALIDATOR_URL: 'https://kosit.internal:8081' }),
        ),
      ).not.toThrow();
    });

    it('rejects an unparseable DATABASE_URL without printing it', () => {
      expect(() =>
        validateEnv(baseEnv({ DATABASE_URL: 'not a url at all' })),
      ).toThrow('DATABASE_URL');
      try {
        validateEnv(baseEnv({ DATABASE_URL: 'not a url at all' }));
      } catch (error) {
        expect(String(error)).not.toContain('not a url at all');
      }
    });

    it('rejects an illegal schema query parameter on DATABASE_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({
            DATABASE_URL:
              'postgresql://user:pass@localhost:5432/db?schema=pg_catalog',
          }),
        ),
      ).toThrow('DATABASE_URL');
    });

    it('accepts a legal schema query parameter on DATABASE_URL', () => {
      expect(() =>
        validateEnv(
          baseEnv({
            DATABASE_URL:
              'postgresql://user:pass@localhost:5432/db?schema=public',
          }),
        ),
      ).not.toThrow();
    });
  });

  describe('blank versus missing numeric input', () => {
    it('rejects an explicitly blank OCR_MIN_MEAN_CONFIDENCE', () => {
      expect(() =>
        validateEnv(baseEnv({ OCR_MIN_MEAN_CONFIDENCE: '' })),
      ).toThrow('OCR_MIN_MEAN_CONFIDENCE');
    });

    it('rejects a whitespace-only OCR_MIN_MEAN_CONFIDENCE', () => {
      expect(() =>
        validateEnv(baseEnv({ OCR_MIN_MEAN_CONFIDENCE: '   ' })),
      ).toThrow('OCR_MIN_MEAN_CONFIDENCE');
    });

    it('defaults a missing OCR_MIN_MEAN_CONFIDENCE to 80', () => {
      const env = baseEnv();
      delete env.OCR_MIN_MEAN_CONFIDENCE;
      expect(validateEnv(env)).toMatchObject({ OCR_MIN_MEAN_CONFIDENCE: 80 });
    });

    it('accepts an explicit zero OCR_MIN_MEAN_CONFIDENCE', () => {
      expect(
        validateEnv(baseEnv({ OCR_MIN_MEAN_CONFIDENCE: '0' })),
      ).toMatchObject({ OCR_MIN_MEAN_CONFIDENCE: 0 });
    });

    it('rejects a blank TRUSTED_PROXY_HOPS', () => {
      expect(() => validateEnv(baseEnv({ TRUSTED_PROXY_HOPS: '' }))).toThrow(
        'TRUSTED_PROXY_HOPS',
      );
    });

    it('defaults a missing TRUSTED_PROXY_HOPS to 0', () => {
      expect(validateEnv(baseEnv())).toMatchObject({ TRUSTED_PROXY_HOPS: 0 });
    });

    it('accepts an explicit zero TRUSTED_PROXY_HOPS', () => {
      expect(validateEnv(baseEnv({ TRUSTED_PROXY_HOPS: '0' }))).toMatchObject({
        TRUSTED_PROXY_HOPS: 0,
      });
    });
  });

  describe('runtime-bounded numeric ranges', () => {
    it('rejects a PORT above 65535', () => {
      expect(() => validateEnv(baseEnv({ PORT: 65536 }))).toThrow('PORT');
    });

    it('accepts the maximum legal PORT', () => {
      expect(() => validateEnv(baseEnv({ PORT: 65535 }))).not.toThrow();
    });

    it('rejects a TRUSTED_PROXY_HOPS above 2', () => {
      expect(() => validateEnv(baseEnv({ TRUSTED_PROXY_HOPS: 3 }))).toThrow(
        'TRUSTED_PROXY_HOPS',
      );
    });

    it('accepts TRUSTED_PROXY_HOPS of 2', () => {
      expect(() =>
        validateEnv(baseEnv({ TRUSTED_PROXY_HOPS: 2 })),
      ).not.toThrow();
    });

    it('rejects an OCR_TIMEOUT_MS * MAX_PAGES product beyond the timer range', () => {
      expect(() =>
        validateEnv(baseEnv({ OCR_TIMEOUT_MS: 100_000_000, MAX_PAGES: 100 })),
      ).toThrow('OCR_TIMEOUT_MS');
    });

    it('accepts an OCR_TIMEOUT_MS * MAX_PAGES product within the timer range', () => {
      expect(() =>
        validateEnv(baseEnv({ OCR_TIMEOUT_MS: 15_000, MAX_PAGES: 30 })),
      ).not.toThrow();
    });

    it('rejects a CLEANUP_INTERVAL_MINUTES product beyond the timer range', () => {
      expect(() =>
        validateEnv(baseEnv({ CLEANUP_INTERVAL_MINUTES: 40_000 })),
      ).toThrow('CLEANUP_INTERVAL_MINUTES');
    });

    it('rejects an LLM_REQUEST_TIMEOUT_MS beyond the timer range', () => {
      expect(() =>
        validateEnv(baseEnv({ LLM_REQUEST_TIMEOUT_MS: 5_000_000_000 })),
      ).toThrow('LLM_REQUEST_TIMEOUT_MS');
    });
  });

  describe('whitespace-only required strings', () => {
    it('rejects a whitespace-only SESSION_SECRET in production', () => {
      expect(() =>
        validateEnv(
          baseEnv({
            NODE_ENV: 'production',
            SESSION_SECRET: ' '.repeat(32),
            LLM_PROVIDER: 'gemini',
            GEMINI_API_KEY: 'test-key',
          }),
        ),
      ).toThrow('SESSION_SECRET');
    });

    it('rejects a whitespace-only GEMINI_API_KEY when required', () => {
      expect(() =>
        validateEnv(baseEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: '   ' })),
      ).toThrow('GEMINI_API_KEY');
    });

    it('rejects a whitespace-only GROQ_API_KEY when required', () => {
      expect(() =>
        validateEnv(baseEnv({ LLM_PROVIDER: 'groq', GROQ_API_KEY: '   ' })),
      ).toThrow('GROQ_API_KEY');
    });

    it('rejects a whitespace-only STORAGE_PATH', () => {
      expect(() => validateEnv(baseEnv({ STORAGE_PATH: '   ' }))).toThrow(
        'STORAGE_PATH',
      );
    });

    it('rejects an empty STORAGE_PATH', () => {
      expect(() => validateEnv(baseEnv({ STORAGE_PATH: '' }))).toThrow(
        'STORAGE_PATH',
      );
    });

    it('defaults a missing STORAGE_PATH', () => {
      const env = baseEnv();
      delete env.STORAGE_PATH;
      expect(validateEnv(env)).toMatchObject({
        STORAGE_PATH: './data/uploads',
      });
    });

    it('rejects a whitespace-only QUEUE_PREFIX', () => {
      expect(() => validateEnv(baseEnv({ QUEUE_PREFIX: '   ' }))).toThrow(
        'QUEUE_PREFIX',
      );
    });

    it('rejects a whitespace-only model id', () => {
      expect(() => validateEnv(baseEnv({ GEMINI_MODEL: '   ' }))).toThrow(
        'GEMINI_MODEL',
      );
    });
  });
});

describe('isLegalPostgresSchemaName', () => {
  it('accepts the current public and e2e schema forms', () => {
    expect(isLegalPostgresSchemaName('public')).toBe(true);
    expect(isLegalPostgresSchemaName(`e2e_${'a'.repeat(32)}`)).toBe(true);
  });

  it('accepts a 63-byte identifier and rejects a 64-byte one', () => {
    expect(isLegalPostgresSchemaName('a'.repeat(63))).toBe(true);
    expect(isLegalPostgresSchemaName('a'.repeat(64))).toBe(false);
  });

  it('rejects the pg_ prefix regardless of case', () => {
    expect(isLegalPostgresSchemaName('pg_foo')).toBe(false);
    expect(isLegalPostgresSchemaName('PG_foo')).toBe(false);
  });

  it('rejects the reserved system namespaces regardless of case', () => {
    expect(isLegalPostgresSchemaName('pg_catalog')).toBe(false);
    expect(isLegalPostgresSchemaName('Pg_Catalog')).toBe(false);
    expect(isLegalPostgresSchemaName('information_schema')).toBe(false);
    expect(isLegalPostgresSchemaName('Information_Schema')).toBe(false);
  });

  it('rejects punctuation outside the legal identifier charset', () => {
    expect(isLegalPostgresSchemaName('bad-name')).toBe(false);
    expect(isLegalPostgresSchemaName('bad.name')).toBe(false);
    expect(isLegalPostgresSchemaName('bad;name')).toBe(false);
  });
});
