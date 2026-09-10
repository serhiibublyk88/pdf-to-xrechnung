import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { OwnerSessionService } from './../src/sessions/owner-session.service';
import { createOwnerSession } from './fixtures/owner-session';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('Global exception filter (e2e)', () => {
  let app: INestApplication<App>;
  let loggedLines: string[];

  function parsedLogLines(): Record<string, unknown>[] {
    return loggedLines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeAll(async () => {
    loggedLines = [];
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        loggedLines.push(chunk.toString());
        return true;
      });

    const throwingOwnerSessions: Pick<OwnerSessionService, 'requireOwnerId'> = {
      requireOwnerId: () => {
        throw new Error(
          'SYNTHETIC_INTERNAL_FAILURE: unexpected owner lookup crash',
        );
      },
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OwnerSessionService)
      .useValue(throwingOwnerSessions)
      .compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    loggedLines.length = 0;
  });

  it('returns a generic 500 body with no stack or thrown text for a genuinely unhandled exception', async () => {
    const response = await request(app.getHttpServer()).get('/invoices');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
    const responseText = JSON.stringify(response.body);
    expect(responseText).not.toContain('SYNTHETIC_INTERNAL_FAILURE');
    expect(responseText.toLowerCase()).not.toContain('stack');
  });

  it('logs the unhandled exception exactly once through the structured serializer', async () => {
    await request(app.getHttpServer()).get('/invoices');

    const handledLines = parsedLogLines().filter(
      (entry) => entry.msg === 'Unhandled request exception',
    );

    expect(handledLines).toHaveLength(1);
    const err = handledLines[0]?.err as
      { type?: string; message?: string } | undefined;
    expect(err?.type).toBe('Error');
    expect(err?.message).toContain('SYNTHETIC_INTERNAL_FAILURE');
  });
});

describe('Global exception filter — real client statuses (e2e)', () => {
  let app: INestApplication<App>;
  let loggedLines: string[];

  function parsedLogLines(): Record<string, unknown>[] {
    return loggedLines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeAll(async () => {
    loggedLines = [];
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        loggedLines.push(chunk.toString());
        return true;
      });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('preserves a real body-parser status without leaking its internal message or a stack trace', async () => {
    const oversized = 'a'.repeat(200 * 1024);
    const { cookie } = await createOwnerSession(app);

    const response = await request(app.getHttpServer())
      .post(`/invoices/00000000-0000-0000-0000-000000000000/review`)
      .set('Cookie', cookie)
      .send({ lifecycleToken: '0'.repeat(64), correctedData: oversized });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      statusCode: 413,
      message: 'Payload Too Large',
    });
    const responseText = JSON.stringify(response.body);
    expect(responseText).not.toContain('entity too large');
    expect(responseText.toLowerCase()).not.toContain('stack');
  });

  it('keeps a 400 message and statusCode reachable while dropping the optional error field', async () => {
    const { cookie } = await createOwnerSession(app);

    const response = await request(app.getHttpServer())
      .post('/invoices/00000000-0000-0000-0000-000000000000/review')
      .set('Cookie', cookie)
      .send({ lifecycleToken: 'not-hex', correctedData: {} });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      message: 'Review request has an invalid shape',
    });
  });

  it('keeps a bare 404 reachable with its default message and no error field', async () => {
    const { cookie } = await createOwnerSession(app);

    const response = await request(app.getHttpServer())
      .get('/invoices/00000000-0000-0000-0000-000000000000/review')
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ statusCode: 404, message: 'Not Found' });
  });

  it('leaves no error-level line behind for an ordinary client error', async () => {
    const { cookie } = await createOwnerSession(app);
    loggedLines.length = 0;

    await request(app.getHttpServer())
      .get('/invoices/00000000-0000-0000-0000-000000000000/review')
      .set('Cookie', cookie)
      .expect(404);

    const entries = parsedLogLines();

    expect(entries.some((entry) => entry.msg === 'request completed')).toBe(
      true,
    );
    expect(entries.filter((entry) => Number(entry.level) >= 50)).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain('stack');
  });

  it('keeps a 401 message reachable for a missing session', async () => {
    const response = await request(app.getHttpServer()).get('/invoices');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      message: 'A valid anonymous session is required',
    });
  });

  it('still carries Retry-After on a 429', async () => {
    let lastStatus = 0;
    let lastRetryAfter: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await request(app.getHttpServer()).post('/sessions');
      lastStatus = response.status;
      lastRetryAfter = response.headers['retry-after'];
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);
    expect(lastRetryAfter).toBeDefined();
    expect(Number(lastRetryAfter)).toBeGreaterThan(0);
  });
});
