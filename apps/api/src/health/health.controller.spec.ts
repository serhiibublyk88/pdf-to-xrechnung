import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { KositClient } from '../generation/kosit-client';
import { HEALTH_REDIS_CLIENT, HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };
  let redis: { ping: jest.Mock; disconnect: jest.Mock };
  let kosit: { checkHealth: jest.Mock };
  let logger: { error: jest.Mock; setContext: jest.Mock };

  beforeEach(async () => {
    logger = { error: jest.fn(), setContext: jest.fn() };
    prisma = { $queryRaw: jest.fn() };
    redis = { ping: jest.fn(), disconnect: jest.fn() };
    kosit = { checkHealth: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: HEALTH_REDIS_CLIENT, useValue: redis },
        { provide: KositClient, useValue: kosit },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports process liveness without probing dependencies', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
    expect(kosit.checkHealth).not.toHaveBeenCalled();
  });

  it('reports all three readiness dependencies as reachable', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');
    kosit.checkHealth.mockResolvedValue(null);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'up',
      kosit: 'up',
    });
  });

  it('reports the database as unreachable without hiding the others', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');
    kosit.checkHealth.mockResolvedValue(null);

    const check = controller.ready();
    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(check).rejects.toMatchObject({
      response: { database: 'down', redis: 'up', kosit: 'up' },
    });
  });

  it('reports Redis as unreachable without hiding the others', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockRejectedValue(new Error('connection refused'));
    kosit.checkHealth.mockResolvedValue(null);

    const check = controller.ready();
    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(check).rejects.toMatchObject({
      response: { database: 'up', redis: 'down', kosit: 'up' },
    });
  });

  it('reports KoSIT as unreachable without hiding the others, and logs the reason', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');
    kosit.checkHealth.mockResolvedValue('connect ECONNREFUSED');

    const check = controller.ready();
    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(check).rejects.toMatchObject({
      response: { database: 'up', redis: 'up', kosit: 'down' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      { kositError: 'connect ECONNREFUSED' },
      'KoSIT readiness check failed',
    );
  });

  it('reports a database that accepts the connection but never answers as down', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));
    redis.ping.mockResolvedValue('PONG');
    kosit.checkHealth.mockResolvedValue(null);

    const check = controller.ready();
    const assertion = expect(check).rejects.toMatchObject({
      response: { database: 'down', redis: 'up', kosit: 'up' },
    });
    await jest.advanceTimersByTimeAsync(3_000);
    await assertion;
    jest.useRealTimers();
  });

  it('disconnects the Redis client on shutdown', () => {
    controller.onModuleDestroy();

    expect(redis.disconnect).toHaveBeenCalled();
  });
});
