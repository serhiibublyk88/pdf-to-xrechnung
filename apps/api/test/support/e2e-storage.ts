import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const E2E_STORAGE_PREFIX = 'invoice-extract-e2e-';
const OWNER_FILE = '.owner-pid';
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;

interface ReaperOptions {
  root?: string;
  nowMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    );
  }
}

function ownerPid(storagePath: string): number | undefined {
  try {
    const value = readFileSync(join(storagePath, OWNER_FILE), 'utf8').trim();
    if (!/^\d+$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pathIsMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createOwnedE2eStorage(root = tmpdir()): string {
  const storagePath = mkdtempSync(join(root, E2E_STORAGE_PREFIX));
  try {
    writeFileSync(join(storagePath, OWNER_FILE), `${process.pid}\n`, {
      mode: 0o600,
    });
    return storagePath;
  } catch (error) {
    rmSync(storagePath, { recursive: true, force: true });
    throw error;
  }
}

export function reapOrphanedE2eStorage({
  root = tmpdir(),
  nowMs = Date.now(),
  isProcessAlive = processIsAlive,
}: ReaperOptions = {}): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(E2E_STORAGE_PREFIX)) {
      continue;
    }
    const storagePath = join(root, entry.name);
    try {
      const pid = ownerPid(storagePath);
      const stale = nowMs - statSync(storagePath).mtimeMs >= ORPHAN_AGE_MS;
      const removable = (pid !== undefined && !isProcessAlive(pid)) || stale;
      if (removable) rmSync(storagePath, { recursive: true, force: true });
    } catch (error) {
      if (!pathIsMissing(error)) throw error;
    }
  }
}
