import { Module } from '@nestjs/common';
import { LocalStorage } from './local-storage';
import { STORAGE_SERVICE } from './storage.interface';

@Module({
  providers: [{ provide: STORAGE_SERVICE, useClass: LocalStorage }],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
