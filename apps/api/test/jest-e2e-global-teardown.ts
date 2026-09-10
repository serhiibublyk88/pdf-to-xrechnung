import 'dotenv/config';
import { cleanupE2eResources } from './support/e2e-cleanup';

export default async function globalTeardown(): Promise<void> {
  const schema = process.env.E2E_DATABASE_SCHEMA;
  const prefix = process.env.QUEUE_PREFIX;
  const storagePath = process.env.E2E_STORAGE_PATH;
  if (
    !schema ||
    !prefix ||
    !storagePath ||
    !process.env.E2E_ADMIN_DATABASE_URL ||
    !process.env.REDIS_URL
  ) {
    throw new Error('E2E isolation state is missing');
  }

  await cleanupE2eResources({
    databaseUrl: process.env.E2E_ADMIN_DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    schema,
    prefix,
    storagePath,
  });
}
