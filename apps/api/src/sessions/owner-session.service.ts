import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.schema';

const COOKIE_NAME = 'invoice_session';

@Injectable()
export class OwnerSessionService {
  private readonly retentionMs: number;
  private readonly secret: string;
  private readonly secureCookie: boolean;

  constructor(configService: ConfigService<Env, true>) {
    this.retentionMs = configService.get('RETENTION_HOURS') * 60 * 60 * 1000;
    this.secret = configService.get('SESSION_SECRET');
    this.secureCookie = configService.get('NODE_ENV') === 'production';
  }

  createSetCookieHeader(now = Date.now()): string {
    return this.buildSetCookieHeader(randomUUID(), now);
  }

  refreshSetCookieHeader(ownerId: string, now = Date.now()): string {
    return this.buildSetCookieHeader(ownerId, now);
  }

  private buildSetCookieHeader(ownerId: string, now: number): string {
    const expiresAt = now + this.retentionMs;
    const signature = this.sign(ownerId, expiresAt);
    const secure = this.secureCookie ? '; Secure' : '';
    const maxAgeSeconds = Math.ceil(this.retentionMs / 1000);

    return `${COOKIE_NAME}=${ownerId}.${expiresAt}.${signature}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  requireOwnerId(rawCookie: string | undefined): string {
    const ownerId = this.ownerIdFromCookie(rawCookie);
    if (!ownerId) {
      throw new UnauthorizedException('A valid anonymous session is required');
    }
    return ownerId;
  }

  // A browser can send several cookies of the same name, indistinguishable here.
  ownerIdFromCookie(
    rawCookie: string | undefined,
    now = Date.now(),
  ): string | null {
    for (const session of this.cookieValues(rawCookie)) {
      const ownerId = this.verifiedOwnerId(session, now);
      if (ownerId) {
        return ownerId;
      }
    }
    return null;
  }

  private verifiedOwnerId(session: string, now: number): string | null {
    const [ownerId, expiresAtValue, signature, ...rest] = session.split('.');
    if (
      rest.length > 0 ||
      !ownerId ||
      !expiresAtValue ||
      !signature ||
      !isUuid(ownerId) ||
      !/^\d+$/.test(expiresAtValue) ||
      !/^[0-9a-f]{64}$/.test(signature)
    ) {
      return null;
    }

    const expiresAt = Number(expiresAtValue);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      return null;
    }

    const expectedSignature = this.sign(ownerId, expiresAt);
    const suppliedSignature = Buffer.from(signature, 'hex');
    const expectedSignatureBuffer = Buffer.from(expectedSignature, 'hex');
    if (
      suppliedSignature.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(suppliedSignature, expectedSignatureBuffer)
    ) {
      return null;
    }

    return ownerId;
  }

  private cookieValues(rawCookie: string | undefined): string[] {
    if (!rawCookie) {
      return [];
    }

    const values: string[] = [];
    for (const cookie of rawCookie.split(';')) {
      const [name, ...valueParts] = cookie.trim().split('=');
      const value = valueParts[0];
      if (name === COOKIE_NAME && valueParts.length === 1 && value) {
        values.push(value);
      }
    }
    return values;
  }

  private sign(ownerId: string, expiresAt: number): string {
    return createHmac('sha256', this.secret)
      .update(`${ownerId}.${expiresAt}`)
      .digest('hex');
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
