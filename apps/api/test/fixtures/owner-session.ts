import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

export interface OwnerSession {
  ownerId: string;
  cookie: string;
}

export async function createOwnerSession(
  app: INestApplication<App>,
): Promise<OwnerSession> {
  const response = await request(app.getHttpServer())
    .post('/sessions')
    .expect(204);

  return ownerSessionFromHeaders(response.headers);
}

export function ownerSessionFromHeaders(headers: unknown): OwnerSession {
  if (!isRecord(headers)) {
    throw new Error('Expected the session endpoint to return headers');
  }

  const setCookie = headers['set-cookie'];
  if (!isStringArray(setCookie)) {
    throw new Error('Expected the session endpoint to issue a cookie');
  }

  const [firstSetCookie] = setCookie;
  if (!firstSetCookie) {
    throw new Error('Expected the session endpoint to issue a cookie');
  }
  const separator = firstSetCookie.indexOf(';');
  const cookie =
    separator === -1 ? firstSetCookie : firstSetCookie.slice(0, separator);
  const ownerId = /^invoice_session=([0-9a-f-]{36})\./i.exec(cookie)?.[1];
  if (!ownerId) {
    throw new Error('Expected a UUID owner id in the session cookie');
  }

  return { ownerId, cookie };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}
