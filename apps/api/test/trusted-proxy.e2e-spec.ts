import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { createApp } from './../src/main';
import type { Env } from './../src/config/env.schema';
import { createOwnerSession } from './fixtures/owner-session';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('Trusted proxy hop count and rate-limit bucketing (e2e)', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
  });

  async function exhaustStatusBucket(
    cookie: string,
    forwardedFor: string,
  ): Promise<void> {
    const statusPath = `/invoices/${randomUUID()}`;
    for (let attempt = 0; attempt < 130; attempt++) {
      const response = await request(app.getHttpServer())
        .get(statusPath)
        .set('Cookie', cookie)
        .set('X-Forwarded-For', forwardedFor);
      if (response.status === 429) return;
    }
    throw new Error('Expected the status endpoint to become rate-limited');
  }

  it('applies TRUSTED_PROXY_HOPS from config to the underlying trust proxy setting', async () => {
    app = await createApp();
    await listenOnLoopback(app);
    const configService = app.get<ConfigService<Env, true>>(ConfigService);

    expect(app.getHttpAdapter().getInstance().get('trust proxy')).toBe(
      configService.get('TRUSTED_PROXY_HOPS'),
    );
  });

  it('trusts one hop and gives two distinct forwarded addresses separate buckets', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    await listenOnLoopback(app);
    const { cookie } = await createOwnerSession(app);

    await exhaustStatusBucket(cookie, '9.9.9.1');

    const otherClient = await request(app.getHttpServer())
      .get(`/invoices/${randomUUID()}`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '9.9.9.2');

    expect(otherClient.status).not.toBe(429);
  });

  it('ignores a client-supplied X-Forwarded-For when zero hops are trusted', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 0);
    await listenOnLoopback(app);
    const { cookie } = await createOwnerSession(app);

    await exhaustStatusBucket(cookie, '1.1.1.1');

    const spoofedClient = await request(app.getHttpServer())
      .get(`/invoices/${randomUUID()}`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '2.2.2.2');

    expect(spoofedClient.status).toBe(429);
  });
});
