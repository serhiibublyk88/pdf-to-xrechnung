import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Env } from '../config/env.schema';

@Controller('extraction-mode')
@UseGuards(ThrottlerGuard)
export class ExtractionModeController {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  mode(): { demo: boolean } {
    return { demo: this.configService.get('LLM_PROVIDER') === 'mock' };
  }
}
