import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedE2eStorage, reapOrphanedE2eStorage } from './e2e-storage';

describe('e2e storage ownership', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'e2e-storage-spec-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records the creating process as owner', () => {
    const storagePath = createOwnedE2eStorage(root);

    expect(readFileSync(join(storagePath, '.owner-pid'), 'utf8')).toBe(
      `${process.pid}\n`,
    );
  });

  it('removes only dead owners and old legacy directories', () => {
    const nowMs = Date.now();
    const active = join(root, 'invoice-extract-e2e-active');
    const dead = join(root, 'invoice-extract-e2e-dead');
    const recentLegacy = join(root, 'invoice-extract-e2e-recent');
    const oldLegacy = join(root, 'invoice-extract-e2e-old');
    for (const storagePath of [active, dead, recentLegacy, oldLegacy]) {
      mkdirSync(storagePath);
    }
    writeFileSync(join(active, '.owner-pid'), '101\n');
    writeFileSync(join(dead, '.owner-pid'), '202\n');
    const old = new Date(nowMs - 25 * 60 * 60 * 1_000);
    utimesSync(oldLegacy, old, old);

    reapOrphanedE2eStorage({
      root,
      nowMs,
      isProcessAlive: (pid) => pid === 101,
    });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(recentLegacy)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(oldLegacy)).toBe(false);
  });

  it('removes an owned directory that outlived the orphan age', () => {
    const nowMs = Date.now();
    const recycledOwner = join(root, 'invoice-extract-e2e-recycled');
    mkdirSync(recycledOwner);
    writeFileSync(join(recycledOwner, '.owner-pid'), '404\n');
    const old = new Date(nowMs - 25 * 60 * 60 * 1_000);
    utimesSync(recycledOwner, old, old);

    reapOrphanedE2eStorage({ root, nowMs, isProcessAlive: () => true });

    expect(existsSync(recycledOwner)).toBe(false);
  });
});
