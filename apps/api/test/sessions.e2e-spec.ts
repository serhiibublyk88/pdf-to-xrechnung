import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import pinoHttp from 'pino-http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { LOG_REDACT_PATHS } from './../src/config/log-redaction';
import { OwnerSessionService } from './../src/sessions/owner-session.service';
import { createOwnerSession } from './fixtures/owner-session';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('SessionsController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('issues an HttpOnly signed cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/sessions')
      .expect(204);

    const setCookie: unknown = response.headers['set-cookie'];
    if (!Array.isArray(setCookie) || typeof setCookie[0] !== 'string') {
      throw new Error('Expected the session endpoint to issue a cookie');
    }
    expect(setCookie[0]).toContain('HttpOnly');
    expect(setCookie[0]).toContain('SameSite=Lax');
  });

  it('does not leak the issued session cookie into request logs', async () => {
    const ownerSessions = app.get(OwnerSessionService);
    const setCookieHeader = ownerSessions.createSetCookieHeader();
    const cookieMatch =
      /^invoice_session=([0-9a-f-]{36})\.\d+\.([0-9a-f]{64});/.exec(
        setCookieHeader,
      );
    if (!cookieMatch) {
      throw new Error(
        'Expected a parsable session cookie for the log-redaction test',
      );
    }
    const [, ownerId, signature] = cookieMatch;

    const logChunks: Buffer[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk);
        callback();
      },
    });
    const logger = pinoHttp({ redact: LOG_REDACT_PATHS }, logStream);
    const server = createServer((req, res) => {
      logger(req, res);
      res.statusCode = 204;
      res.setHeader('Set-Cookie', setCookieHeader);
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      await request(server)
        .post('/sessions')
        .set('Cookie', 'invoice_session=stale.1.deadbeef')
        .expect(204);
      await new Promise((resolve) => setImmediate(resolve));

      const logged = Buffer.concat(logChunks).toString('utf8');
      expect(logged).toContain('"set-cookie":"[Redacted]"');
      expect(logged).not.toContain(ownerId);
      expect(logged).not.toContain(signature);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refreshes a still-valid session for the same owner instead of no-opping', async () => {
    const initial = await createOwnerSession(app);

    const response = await request(app.getHttpServer())
      .post('/sessions')
      .set('Cookie', initial.cookie)
      .expect(204);

    const setCookie: unknown = response.headers['set-cookie'];
    if (!Array.isArray(setCookie) || typeof setCookie[0] !== 'string') {
      throw new Error(
        'Expected the session endpoint to issue a refreshed cookie',
      );
    }
    expect(setCookie[0]).toMatch(
      new RegExp(`^invoice_session=${initial.ownerId}\\.`),
    );
  });

  it('bounds session issuance on its own budget instead of spending the upload budget', async () => {
    const uploadBudget = Number(process.env.RATE_LIMIT_PER_HOUR);
    if (!Number.isInteger(uploadBudget) || uploadBudget <= 0) {
      throw new Error('Expected RATE_LIMIT_PER_HOUR to be configured');
    }

    const attemptLimit = 200;
    let accepted = 0;
    let lastStatus = 0;
    while (accepted < attemptLimit) {
      const { status } = await request(app.getHttpServer()).post('/sessions');
      lastStatus = status;
      if (status !== 204) {
        break;
      }
      accepted++;
    }

    expect(lastStatus).toBe(429);
    expect(accepted).toBeGreaterThan(uploadBudget);
  });
});
