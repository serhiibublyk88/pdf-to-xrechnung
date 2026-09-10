import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CleanupModule } from './cleanup/cleanup.module';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env.schema';
import { LOG_BASE_OPTIONS } from './config/log-redaction';
import { DataExtractionModule } from './data-extraction/data-extraction.module';
import { ExtractionModule } from './extraction/extraction.module';
import { GenerationModule } from './generation/generation.module';
import { HealthModule } from './health/health.module';
import { HttpExceptionFilter } from './http/http-exception.filter';
import { InvoicesModule } from './invoices/invoices.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReviewModule } from './review/review.module';
import { SessionsModule } from './sessions/sessions.module';
import { ValidationModule } from './validation/validation.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => ({
        pinoHttp: {
          ...LOG_BASE_OPTIONS,
          level: configService.get('LOG_LEVEL'),
          transport:
            configService.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: 60 * 60 * 1000,
            limit: configService.get('RATE_LIMIT_PER_HOUR'),
          },
        ],
      }),
    }),
    PrismaModule,
    SessionsModule,
    InvoicesModule,
    ExtractionModule,
    DataExtractionModule,
    ValidationModule,
    GenerationModule,
    ReviewModule,
    CleanupModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
