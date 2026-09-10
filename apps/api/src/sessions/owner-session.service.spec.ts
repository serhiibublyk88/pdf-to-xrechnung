import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OwnerSessionService } from './owner-session.service';

const DEFAULT_SECRET =
  'test-session-secret-that-is-long-enough-to-sign-cookies';

interface OwnerSessionsOverrides {
  retentionHours?: number;
  secret?: string;
  nodeEnv?: 'development' | 'production' | 'test';
}

async function createOwnerSessions(
  overrides: OwnerSessionsOverrides = {},
): Promise<OwnerSessionService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OwnerSessionService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            key === 'RETENTION_HOURS'
              ? (overrides.retentionHours ?? 2)
              : key === 'SESSION_SECRET'
                ? (overrides.secret ?? DEFAULT_SECRET)
                : key === 'NODE_ENV'
                  ? (overrides.nodeEnv ?? 'test')
                  : 'test',
        },
      },
    ],
  }).compile();

  return module.get(OwnerSessionService);
}

function cookiePair(setCookieHeader: string): string {
  return setCookieHeader.slice(0, setCookieHeader.indexOf(';'));
}

function cookieWithValue(value: string): string {
  return `invoice_session=${value}`;
}

function segmentsOf(setCookieHeader: string): {
  ownerId: string;
  expiresAt: string;
  signature: string;
} {
  const value = cookiePair(setCookieHeader).split('=')[1];
  const [ownerId, expiresAt, signature] = (value ?? '').split('.');
  if (!ownerId || !expiresAt || !signature) {
    throw new Error('Expected a well-formed session cookie value');
  }
  return { ownerId, expiresAt, signature };
}

function parseSetCookie(setCookieHeader: string): {
  name: string;
  value: string;
  path: string | undefined;
  sameSite: string | undefined;
  maxAge: number | undefined;
  attributeCounts: Record<string, number>;
} {
  const [pair, ...attributes] = setCookieHeader.split('; ');
  const separatorIndex = pair?.indexOf('=') ?? -1;
  if (!pair || separatorIndex === -1) {
    throw new Error('Expected a name=value pair in the session cookie');
  }
  const name = pair.slice(0, separatorIndex);
  const value = pair.slice(separatorIndex + 1);

  const attributeCounts: Record<string, number> = {};
  let path: string | undefined;
  let sameSite: string | undefined;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const [key, attributeValue] = attribute.split('=');
    if (!key) continue;
    attributeCounts[key] = (attributeCounts[key] ?? 0) + 1;
    if (key === 'Path') path = attributeValue;
    if (key === 'SameSite') sameSite = attributeValue;
    if (key === 'Max-Age' && attributeValue) maxAge = Number(attributeValue);
  }
  return { name, value, path, sameSite, maxAge, attributeCounts };
}

describe('OwnerSessionService', () => {
  it('issues an HttpOnly signed cookie that resolves to an owner id', async () => {
    const ownerSessions = await createOwnerSessions();
    const now = Date.UTC(2026, 7, 11, 12, 0, 0);
    const setCookie = ownerSessions.createSetCookieHeader(now);

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(ownerSessions.ownerIdFromCookie(setCookie, now + 1)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('rejects a cookie whose owner segment breaks the UUID shape', async () => {
    const ownerSessions = await createOwnerSessions();
    const now = Date.UTC(2026, 7, 11, 12, 0, 0);
    const setCookie = ownerSessions.createSetCookieHeader(now);
    const modified = setCookie.replace('invoice_session=', 'invoice_session=0');

    expect(ownerSessions.ownerIdFromCookie(modified, now + 1)).toBeNull();
  });

  it('rejects an expired session even when its signature is valid', async () => {
    const ownerSessions = await createOwnerSessions();
    const now = Date.UTC(2026, 7, 11, 12, 0, 0);
    const setCookie = ownerSessions.createSetCookieHeader(now);

    expect(
      ownerSessions.ownerIdFromCookie(setCookie, now + 2 * 60 * 60 * 1000),
    ).toBeNull();
  });

  it('accepts the valid session when the browser also sends a stale cookie of the same name', async () => {
    const ownerSessions = await createOwnerSessions();
    const now = Date.UTC(2026, 7, 11, 12, 0, 0);
    const stale = cookiePair(
      ownerSessions.createSetCookieHeader(now - 3 * 60 * 60 * 1000),
    );
    const current = cookiePair(ownerSessions.createSetCookieHeader(now));
    const currentOwnerId = ownerSessions.ownerIdFromCookie(current, now + 1);

    expect(
      ownerSessions.ownerIdFromCookie(`${stale}; ${current}`, now + 1),
    ).toBe(currentOwnerId);
  });

  it('refreshes a still-valid cookie for the same owner id with a strictly later expiry', async () => {
    const ownerSessions = await createOwnerSessions();
    const issuedAt = Date.UTC(2026, 7, 11, 12, 0, 0);
    const original = ownerSessions.createSetCookieHeader(issuedAt);
    const originalOwnerId = ownerSessions.ownerIdFromCookie(
      original,
      issuedAt + 1,
    );
    if (!originalOwnerId) {
      throw new Error('Expected the original cookie to resolve to an owner');
    }

    const refreshedAt = issuedAt + 60 * 60 * 1000;
    const refreshed = ownerSessions.refreshSetCookieHeader(
      originalOwnerId,
      refreshedAt,
    );

    expect(refreshed).toContain(`invoice_session=${originalOwnerId}.`);
    expect(ownerSessions.ownerIdFromCookie(refreshed, refreshedAt + 1)).toBe(
      originalOwnerId,
    );
    expect(
      ownerSessions.ownerIdFromCookie(refreshed, issuedAt + 2 * 60 * 60 * 1000),
    ).toBe(originalOwnerId);
  });

  describe('HMAC authenticity and signed expiry', () => {
    it('signs the cookie with HMAC-SHA256 over exactly ownerId.expiresAt', async () => {
      const secret = 'independently-verified-session-secret-for-this-case';
      const ownerSessions = await createOwnerSessions({ secret });
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = ownerSessions.createSetCookieHeader(now);
      const { ownerId, expiresAt, signature } = segmentsOf(genuine);

      const expectedSignature = createHmac('sha256', secret)
        .update(`${ownerId}.${expiresAt}`)
        .digest('hex');

      expect(signature).toBe(expectedSignature);
    });

    it('rejects a cookie whose owner id was replaced with another legal UUID v4', async () => {
      const ownerSessions = await createOwnerSessions();
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = ownerSessions.createSetCookieHeader(now);
      const { expiresAt, signature } = segmentsOf(genuine);
      const anotherOwnerId = randomUUID();

      expect(
        ownerSessions.ownerIdFromCookie(
          cookieWithValue(`${anotherOwnerId}.${expiresAt}.${signature}`),
          now + 1,
        ),
      ).toBeNull();
    });

    it('rejects a cookie whose expiry was extended while keeping the original signature', async () => {
      const ownerSessions = await createOwnerSessions();
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = ownerSessions.createSetCookieHeader(now);
      const { ownerId, expiresAt, signature } = segmentsOf(genuine);
      const extendedExpiresAt = Number(expiresAt) + 1;

      expect(
        ownerSessions.ownerIdFromCookie(
          cookieWithValue(`${ownerId}.${extendedExpiresAt}.${signature}`),
          now + 1,
        ),
      ).toBeNull();
    });

    it('rejects a cookie whose signature was altered by a single hex digit', async () => {
      const ownerSessions = await createOwnerSessions();
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = ownerSessions.createSetCookieHeader(now);
      const { ownerId, expiresAt, signature } = segmentsOf(genuine);
      const firstDigit = signature[0];
      const tamperedSignature =
        (firstDigit === '0' ? '1' : '0') + signature.slice(1);

      expect(
        ownerSessions.ownerIdFromCookie(
          cookieWithValue(`${ownerId}.${expiresAt}.${tamperedSignature}`),
          now + 1,
        ),
      ).toBeNull();
    });

    it('rejects a genuine cookie signed with a different secret', async () => {
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const secretA = await createOwnerSessions({
        secret: 'session-secret-a-that-is-long-enough-to-sign-cookies',
      });
      const secretB = await createOwnerSessions({
        secret: 'session-secret-b-that-is-long-enough-to-sign-cookies',
      });
      const genuine = secretA.createSetCookieHeader(now);

      expect(secretB.ownerIdFromCookie(genuine, now + 1)).toBeNull();
    });

    it('accepts a cookie the instant before its expiry and rejects it exactly at expiry', async () => {
      const retentionHours = 2;
      const ownerSessions = await createOwnerSessions({ retentionHours });
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = ownerSessions.createSetCookieHeader(now);
      const expiresAt = now + retentionHours * 60 * 60 * 1000;

      expect(
        ownerSessions.ownerIdFromCookie(genuine, expiresAt - 1),
      ).not.toBeNull();
      expect(ownerSessions.ownerIdFromCookie(genuine, expiresAt)).toBeNull();
    });

    it('recovers the genuine owner id when a malformed duplicate cookie precedes it', async () => {
      const ownerSessions = await createOwnerSessions();
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const genuine = cookiePair(ownerSessions.createSetCookieHeader(now));
      const genuineOwnerId = ownerSessions.ownerIdFromCookie(genuine, now + 1);
      const malformedDuplicate = 'invoice_session=not-a-real-session-value';

      expect(
        ownerSessions.ownerIdFromCookie(
          `${malformedDuplicate}; ${genuine}`,
          now + 1,
        ),
      ).toBe(genuineOwnerId);
    });
  });

  describe('production cookie attributes', () => {
    it('sets the full attribute contract once each, with Secure only in production', async () => {
      const now = Date.UTC(2026, 7, 11, 12, 0, 0);
      const retentionHours = 2;
      const production = await createOwnerSessions({
        retentionHours,
        nodeEnv: 'production',
      });
      const development = await createOwnerSessions({
        retentionHours,
        nodeEnv: 'development',
      });

      const productionCookie = production.createSetCookieHeader(now);
      const developmentCookie = development.createSetCookieHeader(now);
      const productionAttributes = parseSetCookie(productionCookie);
      const developmentAttributes = parseSetCookie(developmentCookie);

      expect(productionAttributes.name).toBe('invoice_session');
      expect(productionAttributes.value).toMatch(
        /^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/,
      );
      expect(productionAttributes.path).toBe('/');
      expect(productionAttributes.sameSite).toBe('Lax');
      expect(productionAttributes.attributeCounts).toEqual({
        'Max-Age': 1,
        Path: 1,
        HttpOnly: 1,
        SameSite: 1,
        Secure: 1,
      });
      expect(developmentAttributes.attributeCounts).toEqual({
        'Max-Age': 1,
        Path: 1,
        HttpOnly: 1,
        SameSite: 1,
      });
      expect(productionAttributes.maxAge).toBe(retentionHours * 60 * 60);
    });
  });
});
