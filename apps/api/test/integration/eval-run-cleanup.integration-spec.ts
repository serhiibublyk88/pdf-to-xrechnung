import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

const apiRoot = join(__dirname, '../..');

function evaluationStoragePaths(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith('invoice-extract-eval-'),
    )
    .map((entry) => entry.name)
    .sort();
}

async function evaluationSchemas(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'eval\\_%' ESCAPE '\\' ORDER BY schema_name",
    );
    return result.rows.map((row) => row.schema_name);
  } finally {
    await client.end();
  }
}

describe('evaluation runner cleanup', () => {
  jest.setTimeout(30_000);

  it('removes its schema and storage when application boot fails', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const schemasBefore = await evaluationSchemas(databaseUrl);
    const storageBefore = evaluationStoragePaths();

    const result = spawnSync(
      'npx',
      ['ts-node', 'evals/run.ts', '--only', '001'],
      {
        cwd: apiRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KOSIT_VALIDATOR_URL: 'ftp://invalid',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('KOSIT_VALIDATOR_URL');
    expect(await evaluationSchemas(databaseUrl)).toEqual(schemasBefore);
    expect(evaluationStoragePaths()).toEqual(storageBefore);
  });
});
