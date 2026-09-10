import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import Redis from 'ioredis';
import { Client } from 'pg';
import { E2E_SCHEMA_PATTERN } from './e2e-schema';

const E2E_QUEUE_PREFIX_PATTERN = /^pdf-to-xrechnung:e2e:[a-f0-9]{32}$/;

async function dropE2eDatabaseSchema(
  databaseUrl: string,
  schema: string,
): Promise<void> {
  if (!E2E_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Refusing to drop unexpected database schema: ${schema}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

async function clearE2eRedisPrefix(
  redisUrl: string,
  prefix: string,
): Promise<void> {
  if (!E2E_QUEUE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Refusing to clear unexpected Redis prefix: ${prefix}`);
  }

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

function removeE2eStorage(storagePath: string): void {
  const absolutePath = resolve(storagePath);
  const allowedPrefix = `${resolve(tmpdir())}${sep}invoice-extract-e2e-`;
  if (!absolutePath.startsWith(allowedPrefix)) {
    throw new Error(
      `Refusing to remove unexpected storage path: ${absolutePath}`,
    );
  }
  rmSync(absolutePath, { recursive: true, force: true });
}

export async function cleanupE2eResources({
  databaseUrl,
  redisUrl,
  schema,
  prefix,
  storagePath,
}: {
  databaseUrl: string;
  redisUrl?: string;
  schema: string;
  prefix: string;
  storagePath: string;
}): Promise<void> {
  const cleanup = await Promise.allSettled([
    ...(redisUrl ? [clearE2eRedisPrefix(redisUrl, prefix)] : []),
    dropE2eDatabaseSchema(databaseUrl, schema),
    Promise.resolve().then(() => removeE2eStorage(storagePath)),
  ]);
  const failures = cleanup.flatMap((outcome) => {
    if (outcome.status !== 'rejected') return [];
    return [
      outcome.reason instanceof Error
        ? outcome.reason
        : new Error('E2E cleanup failed with a non-error rejection'),
    ];
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, 'E2E cleanup failed');
  }
}
