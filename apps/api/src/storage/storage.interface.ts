export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

export interface StorageService {
  save(storageKey: string, data: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
}
