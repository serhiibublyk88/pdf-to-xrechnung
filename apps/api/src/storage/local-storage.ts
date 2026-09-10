import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../config/env.schema';
import { isMissingFileError } from './missing-file-error';
import type { StorageService } from './storage.interface';

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STORAGE_KEY_PATTERN = new RegExp(`^${UUID_V4_SOURCE}$`);
const CRASH_TEMP_PATTERN = new RegExp(
  `^${UUID_V4_SOURCE}\\.${UUID_V4_SOURCE}\\.tmp$`,
);
const OWNED_ROOT_MODE = 0o700;
const OWNED_FILE_MODE = 0o600;

@Injectable()
export class LocalStorage implements StorageService, OnModuleInit {
  private readonly basePath: string;

  constructor(configService: ConfigService<Env, true>) {
    this.basePath = configService.get('STORAGE_PATH');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
    await chmod(this.basePath, OWNED_ROOT_MODE);

    const entries = await readdir(this.basePath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(this.basePath, entry.name);
      // rm() never follows a symlink, so a crash-temp symlink's target stays untouched.
      if (
        CRASH_TEMP_PATTERN.test(entry.name) &&
        (entry.isFile() || entry.isSymbolicLink())
      ) {
        await rm(entryPath);
        continue;
      }
      if (entry.isFile() && STORAGE_KEY_PATTERN.test(entry.name)) {
        await chmod(entryPath, OWNED_FILE_MODE);
      }
    }
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    const destinationPath = this.pathFor(storageKey);
    const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, data, {
        flag: 'wx',
        mode: OWNED_FILE_MODE,
      });
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to save ${storageKey} and remove its temporary file`,
        );
      }
      throw error;
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await access(this.pathFor(storageKey));
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error('Storage key must be a valid UUID v4');
    }
    return join(this.basePath, storageKey);
  }
}
