import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HEALTH_REDIS_CLIENT } from './../src/health/health.controller';
import { PrismaService } from './../src/prisma/prisma.service';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('reports process liveness separately from dependencies', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('reports all three real readiness dependencies as reachable', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'up', redis: 'up', kosit: 'up' });
  });

  it('reports 503 with per-dependency detail when the database is unreachable, without stopping the others', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = app.get(PrismaService);
    jest.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('down'));

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(response.body).toEqual({
      status: 'error',
      database: 'down',
      redis: 'up',
      kosit: 'up',
    });
  });

  it('reports 503 with per-dependency detail when Redis is unreachable, without stopping the others', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const redis = app.get<Redis>(HEALTH_REDIS_CLIENT);
    jest.spyOn(redis, 'ping').mockRejectedValue(new Error('down'));

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(response.body).toEqual({
      status: 'error',
      database: 'up',
      redis: 'down',
      kosit: 'up',
    });
  });
});
