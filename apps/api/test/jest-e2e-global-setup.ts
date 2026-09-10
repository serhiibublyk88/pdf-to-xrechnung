import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cleanupE2eResources } from './support/e2e-cleanup';
import {
  createOwnedE2eStorage,
  reapOrphanedE2eStorage,
} from './support/e2e-storage';

export default async function globalSetup(): Promise<void> {
  // Overrides a local .env so e2e never burns real API quota.
  process.env.LLM_PROVIDER = 'mock';

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for e2e tests');
  }

  const runId = randomUUID().replaceAll('-', '');
  const schema = `e2e_${runId}`;
  const queuePrefix = `pdf-to-xrechnung:e2e:${runId}`;
  reapOrphanedE2eStorage();
  const storagePath = createOwnedE2eStorage();
  const migrationUrl = new URL(databaseUrl);
  migrationUrl.searchParams.set('schema', schema);

  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: migrationUrl.toString() },
      stdio: 'inherit',
    });
  } catch (error) {
    const redisUrl = process.env.REDIS_URL;
    try {
      await cleanupE2eResources({
        databaseUrl,
        redisUrl,
        schema,
        prefix: queuePrefix,
        storagePath,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'E2E setup and cleanup failed',
      );
    }
    throw error;
  }

  process.env.DATABASE_URL = migrationUrl.toString();
  process.env.QUEUE_PREFIX = queuePrefix;
  process.env.STORAGE_PATH = storagePath;
  process.env.E2E_ADMIN_DATABASE_URL = databaseUrl;
  process.env.E2E_DATABASE_SCHEMA = schema;
  process.env.E2E_STORAGE_PATH = storagePath;
}
