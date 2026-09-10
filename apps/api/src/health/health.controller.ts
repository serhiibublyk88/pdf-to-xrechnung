import {
  Controller,
  Get,
  Inject,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type Redis from 'ioredis';
import { KositClient } from '../generation/kosit-client';
import { PrismaService } from '../prisma/prisma.service';

export const HEALTH_REDIS_CLIENT = Symbol('HEALTH_REDIS_CLIENT');

type DependencyStatus = 'up' | 'down';

const DATABASE_PROBE_TIMEOUT_MS = 3_000;

@Controller('health')
export class HealthController implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(HEALTH_REDIS_CLIENT) private readonly redis: Redis,
    private readonly kosit: KositClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    database: DependencyStatus;
    redis: DependencyStatus;
    kosit: DependencyStatus;
  }> {
    const databaseQuery = this.prisma.$queryRaw`SELECT 1`;
    // The race loser rejects later, with no one left awaiting it: unhandledRejection.
    void databaseQuery.catch(() => undefined);
    const databaseProbe = Promise.race([
      databaseQuery,
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Database did not answer within ${DATABASE_PROBE_TIMEOUT_MS}ms`,
              ),
            ),
          DATABASE_PROBE_TIMEOUT_MS,
        ).unref();
      }),
    ]);

    const [[database, redis], kositError] = await Promise.all([
      Promise.allSettled([databaseProbe, this.redis.ping()]),
      this.kosit.checkHealth(),
    ]);

    if (database.status === 'rejected') {
      const databaseError: unknown = database.reason;
      this.logger.error(
        { err: databaseError },
        'Database readiness check failed',
      );
    }
    if (redis.status === 'rejected') {
      const redisError: unknown = redis.reason;
      this.logger.error({ err: redisError }, 'Redis readiness check failed');
    }
    if (kositError !== null) {
      this.logger.error({ kositError }, 'KoSIT readiness check failed');
    }

    const databaseStatus: DependencyStatus =
      database.status === 'fulfilled' ? 'up' : 'down';
    const redisStatus: DependencyStatus =
      redis.status === 'fulfilled' ? 'up' : 'down';
    const kositStatus: DependencyStatus = kositError === null ? 'up' : 'down';

    if (
      databaseStatus === 'down' ||
      redisStatus === 'down' ||
      kositStatus === 'down'
    ) {
      throw new ServiceUnavailableException({
        status: 'error',
        database: databaseStatus,
        redis: redisStatus,
        kosit: kositStatus,
      });
    }

    return {
      status: 'ok',
      database: databaseStatus,
      redis: redisStatus,
      kosit: kositStatus,
    };
  }
}
