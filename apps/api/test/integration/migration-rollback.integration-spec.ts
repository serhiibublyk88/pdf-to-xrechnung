import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const REAL_PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const INIT_MIGRATION = '20260807233800_init';
// Keep this under the repo so prisma.config.ts can resolve node_modules in its ancestors.
const SCRATCH_ROOT = join(__dirname, '..', '..', 'tmp');

function adminUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for this integration test');
  }
  return databaseUrl;
}

function schemaScopedUrl(schema: string): string {
  const url = new URL(adminUrl());
  url.searchParams.set('schema', schema);
  return url.toString();
}

async function tableExists(
  admin: Client,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await admin.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return (result.rowCount ?? 0) > 0;
}

describe('Migration transaction atomicity (real prisma migrate deploy)', () => {
  jest.setTimeout(30_000);

  it('leaves no application DDL behind when a wrapped migration fails before COMMIT', async () => {
    const schema = `migtest_${randomUUID().replaceAll('-', '')}`;
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const projectDir = mkdtempSync(join(SCRATCH_ROOT, 'migration-rollback-'));

    try {
      writeFileSync(
        join(projectDir, 'prisma.config.ts'),
        `import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
`,
      );

      const migrationsDir = join(projectDir, 'prisma', 'migrations');
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(
        join(migrationsDir, 'migration_lock.toml'),
        readFileSync(
          join(REAL_PRISMA_DIR, 'migrations', 'migration_lock.toml'),
        ),
      );

      const brokenMigrationDir = join(migrationsDir, INIT_MIGRATION);
      mkdirSync(brokenMigrationDir, { recursive: true });
      const realInitSql = readFileSync(
        join(REAL_PRISMA_DIR, 'migrations', INIT_MIGRATION, 'migration.sql'),
        'utf8',
      );
      const brokenInitSql = realInitSql.replace(
        /\nCOMMIT;\n$/,
        '\nSELECT 1/0;\n\nCOMMIT;\n',
      );
      expect(brokenInitSql).not.toBe(realInitSql);
      writeFileSync(join(brokenMigrationDir, 'migration.sql'), brokenInitSql);

      writeFileSync(
        join(projectDir, 'prisma', 'schema.prisma'),
        readFileSync(join(REAL_PRISMA_DIR, 'schema.prisma')),
      );

      // Use the installed Prisma CLI so the isolated project cannot fetch another version.
      const prismaCli = join(
        require.resolve('prisma/package.json'),
        '..',
        'build',
        'index.js',
      );
      let deployFailed = false;
      try {
        execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
          cwd: projectDir,
          env: { ...process.env, DATABASE_URL: schemaScopedUrl(schema) },
          stdio: 'pipe',
        });
      } catch {
        deployFailed = true;
      }
      expect(deployFailed).toBe(true);

      const admin = new Client({ connectionString: adminUrl() });
      await admin.connect();
      try {
        expect(await tableExists(admin, schema, 'Invoice')).toBe(false);
        expect(await tableExists(admin, schema, 'ExtractionAttempt')).toBe(
          false,
        );
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
