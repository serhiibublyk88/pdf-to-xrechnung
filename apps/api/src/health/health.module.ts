import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { GenerationModule } from '../generation/generation.module';
import { HEALTH_REDIS_CLIENT, HealthController } from './health.controller';

export function createHealthRedisClient(
  configService: Pick<ConfigService<Env, true>, 'get'>,
  logger: Pick<PinoLogger, 'error' | 'setContext'>,
): Redis {
  logger.setContext('HealthRedisClient');
  const client = new Redis(configService.get('REDIS_URL'), {
    connectTimeout: 1000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  client.on('error', (error: Error) =>
    logger.error({ err: error }, 'Health Redis client error'),
  );
  return client;
}

@Module({
  imports: [GenerationModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_REDIS_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: createHealthRedisClient,
    },
  ],
})
export class HealthModule {}
