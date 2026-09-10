import 'dotenv/config';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import globalSetup from '../jest-e2e-global-setup';

function e2eStoragePaths(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith('invoice-extract-e2e-'),
    )
    .map((entry) => entry.name)
    .sort();
}

function createReapableOrphan(): string {
  const orphan = mkdtempSync(join(tmpdir(), 'invoice-extract-e2e-'));
  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  utimesSync(orphan, longAgo, longAgo);
  return orphan;
}

describe('e2e global setup cleanup', () => {
  jest.setTimeout(30_000);

  it('removes allocated storage when migration fails', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalProvider = process.env.LLM_PROVIDER;
    const reapableOrphan = createReapableOrphan();
    const storageBefore = e2eStoragePaths();
    process.env.DATABASE_URL =
      'postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1';

    try {
      await expect(globalSetup()).rejects.toThrow();

      expect(
        e2eStoragePaths().filter((name) => !storageBefore.includes(name)),
      ).toEqual([]);
    } finally {
      rmSync(reapableOrphan, { recursive: true, force: true });
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = originalProvider;
    }
  });
});
