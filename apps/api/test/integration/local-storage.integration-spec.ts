import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/config/env.schema';
import { LocalStorage } from '../../src/storage/local-storage';

const LOCAL_STORAGE_SOURCE = join(
  __dirname,
  '../../src/storage/local-storage.ts',
);
const TEMP_FILE_PATTERN = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/;
const INTERRUPTED_SAVE_BYTE_LENGTH = 512 * 1024 * 1024;

function createStorage(root: string): LocalStorage {
  return new LocalStorage(new ConfigService<Env, true>({ STORAGE_PATH: root }));
}

function waitForEntry(
  root: string,
  predicate: (name: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, (_eventType, filename) => {
      if (typeof filename === 'string' && predicate(filename)) {
        clearTimeout(timer);
        watcher.close();
        resolve(filename);
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for a matching entry in ${root}`));
    }, timeoutMs);
  });
}

async function waitForFirstBytes(
  path: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await lstat(path)).size === 0) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for data in ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function childSaveScript(byteLength: number): string {
  return `
const { ConfigService } = require('@nestjs/config');
const { LocalStorage } = require(process.argv[2]);
const storage = new LocalStorage(new ConfigService({ STORAGE_PATH: process.argv[1] }));
const buffer = Buffer.alloc(${byteLength}, 97);
storage
  .onModuleInit()
  .then(() => storage.save(process.argv[3], buffer))
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
`;
}

describe('LocalStorage (real filesystem)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('distinguishes a missing file from an existing file', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();

    await expect(storage.exists(key)).resolves.toBe(false);
    await storage.save(key, Buffer.from('pdf'));
    await expect(storage.exists(key)).resolves.toBe(true);
  });

  it('rethrows a non-missing filesystem error from exists() instead of reporting it as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'a file where the storage root used to be');

    await expect(storage.exists(randomUUID())).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('rethrows a permission error from exists() instead of reporting it as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();
    await storage.save(key, Buffer.from('pdf'));

    await chmod(root, 0o000);
    try {
      await expect(storage.exists(key)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('publishes the complete file and leaves no temporary file behind', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();

    await storage.save(key, Buffer.from('complete pdf'));

    await expect(storage.read(key)).resolves.toEqual(
      Buffer.from('complete pdf'),
    );
    await expect(readdir(root)).resolves.toEqual([key]);
  });

  it('replaces the previous bytes when the same key is saved again', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();

    await storage.save(key, Buffer.from('first'));
    await storage.save(key, Buffer.from('second'));

    await expect(storage.read(key)).resolves.toEqual(Buffer.from('second'));
    await expect(readdir(root)).resolves.toEqual([key]);
  });

  it('removes the temporary file when publishing fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();
    await mkdir(join(root, key));

    await expect(storage.save(key, Buffer.from('pdf'))).rejects.toBeDefined();
    await expect(readdir(root)).resolves.toEqual([key]);
  });

  it('returns the exact stored bytes, and native ENOENT for a missing key', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();
    await storage.save(key, Buffer.from('pdf bytes'));

    await expect(storage.read(key)).resolves.toEqual(Buffer.from('pdf bytes'));
    await expect(storage.read(randomUUID())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('resolves deleting a missing key instead of throwing', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();

    await expect(storage.delete(randomUUID())).resolves.toBeUndefined();
  });

  it('leaves no destination after a real process crash mid-write, and the next startup removes the orphaned temp file', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const key = randomUUID();

    const child = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        childSaveScript(INTERRUPTED_SAVE_BYTE_LENGTH),
        root,
        LOCAL_STORAGE_SOURCE,
        key,
      ],
      { cwd: join(__dirname, '../..'), stdio: 'ignore' },
    );

    let tempFileName: string;
    try {
      tempFileName = await waitForEntry(root, (name) =>
        TEMP_FILE_PATTERN.test(name),
      );
      await waitForFirstBytes(join(root, tempFileName));
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const afterCrash = await readdir(root);
    expect(afterCrash).toEqual([tempFileName]);
    const partialSize = (await lstat(join(root, tempFileName))).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(INTERRUPTED_SAVE_BYTE_LENGTH);

    const recovered = createStorage(root);
    await recovered.onModuleInit();
    await expect(readdir(root)).resolves.toEqual([]);
  }, 20_000);

  it('removes a synthetic crash-temp file at startup while preserving unrelated entries', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const legalKey = randomUUID();
    await writeFile(join(root, legalKey), 'already published');
    const crashTemp = `${randomUUID()}.${randomUUID()}.tmp`;
    await writeFile(join(root, crashTemp), 'orphaned partial write');
    await writeFile(join(root, 'not-a-temp-file.tmp'), 'malformed suffix');
    await mkdir(join(root, 'unrelated-directory'));

    const storage = createStorage(root);
    await storage.onModuleInit();

    const remaining = (await readdir(root)).sort();
    expect(remaining).toEqual(
      ['not-a-temp-file.tmp', 'unrelated-directory', legalKey].sort(),
    );
  });

  it('saves a new file with owner-only permissions', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();

    await storage.save(key, Buffer.from('pdf'));

    expect((await lstat(join(root, key))).mode & 0o777).toBe(0o600);
  });

  it('creates the storage root with owner-only permissions', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-parent-'));
    const storagePath = join(root, 'uploads');
    const storage = createStorage(storagePath);

    await storage.onModuleInit();

    expect((await lstat(storagePath)).mode & 0o777).toBe(0o700);
  });

  it('corrects an existing permissive root and its legal-key files, without touching a directory, an unrelated filename, or a symlink', async () => {
    const previousUmask = process.umask(0o022);
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-parent-'));
    const storagePath = join(root, 'uploads');
    const legalKey = randomUUID();
    const symlinkKey = randomUUID();
    const symlinkTarget = join(root, 'outside-target.txt');
    try {
      await mkdir(storagePath);
      await writeFile(join(storagePath, legalKey), 'already published');
      await mkdir(join(storagePath, 'subdirectory'));
      await writeFile(join(storagePath, 'not-a-uuid.txt'), 'unrelated file');
      await writeFile(symlinkTarget, 'outside content');
      await symlink(symlinkTarget, join(storagePath, symlinkKey));
    } finally {
      process.umask(previousUmask);
    }

    const storage = createStorage(storagePath);
    await storage.onModuleInit();

    expect((await lstat(storagePath)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(storagePath, legalKey))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(storagePath, 'subdirectory'))).isDirectory()).toBe(
      true,
    );
    expect(
      (await lstat(join(storagePath, 'not-a-uuid.txt'))).mode & 0o777,
    ).toBe(0o644);
    const symlinkStat = await lstat(join(storagePath, symlinkKey));
    expect(symlinkStat.isSymbolicLink()).toBe(true);
    await expect(readlink(join(storagePath, symlinkKey))).resolves.toBe(
      symlinkTarget,
    );
    await expect(readFile(symlinkTarget, 'utf8')).resolves.toBe(
      'outside content',
    );
  });

  it('rejects a traversal key for save, read, delete and exists without touching the outside file', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-parent-'));
    const storagePath = join(root, 'uploads');
    const sentinelPath = join(root, 'sentinel.txt');
    await writeFile(sentinelPath, 'sentinel content');
    const storage = createStorage(storagePath);
    await storage.onModuleInit();
    const traversalKey = '../sentinel.txt';

    await expect(storage.save(traversalKey, Buffer.from('x'))).rejects.toThrow(
      /UUID v4/,
    );
    await expect(storage.read(traversalKey)).rejects.toThrow(/UUID v4/);
    await expect(storage.delete(traversalKey)).rejects.toThrow(/UUID v4/);
    await expect(storage.exists(traversalKey)).rejects.toThrow(/UUID v4/);

    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe(
      'sentinel content',
    );
    await expect(readdir(storagePath)).resolves.toEqual([]);

    const rejection = await storage
      .save(traversalKey, Buffer.from('x'))
      .catch((error: unknown) => error);
    expect(String(rejection)).not.toContain('sentinel');
  });

  it('rejects an absolute or empty storage key without creating any entry', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();

    for (const invalidKey of ['', '/etc/passwd']) {
      await expect(storage.save(invalidKey, Buffer.from('x'))).rejects.toThrow(
        /UUID v4/,
      );
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('accepts a valid random UUID through the full save/read/exists/delete cycle', async () => {
    root = await mkdtemp(join(tmpdir(), 'invoice-storage-'));
    const storage = createStorage(root);
    await storage.onModuleInit();
    const key = randomUUID();

    await storage.save(key, Buffer.from('cycle'));
    await expect(storage.exists(key)).resolves.toBe(true);
    await expect(storage.read(key)).resolves.toEqual(Buffer.from('cycle'));
    await storage.delete(key);
    await expect(storage.exists(key)).resolves.toBe(false);
  });
});
