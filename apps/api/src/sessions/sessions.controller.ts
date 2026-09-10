import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { OwnerSessionService } from './owner-session.service';

@Controller('sessions')
@UseGuards(ThrottlerGuard)
export class SessionsController {
  constructor(private readonly ownerSessions: OwnerSessionService) {}

  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  start(
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): void {
    const ownerId = this.ownerSessions.ownerIdFromCookie(rawCookie);
    response.setHeader(
      'Set-Cookie',
      ownerId
        ? this.ownerSessions.refreshSetCookieHeader(ownerId)
        : this.ownerSessions.createSetCookieHeader(),
    );
  }
}
