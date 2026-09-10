import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import pino from 'pino';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { LOG_BASE_OPTIONS } from './config/log-redaction';

const startupLogger = pino(LOG_BASE_OPTIONS);

const MAX_REVIEW_CORRECTION_BODY_BYTES = 5 * 1024 * 1024;

process.on('unhandledRejection', (reason) => {
  startupLogger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  startupLogger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  app.enableShutdownHooks();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      frameguard: { action: 'sameorigin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.useBodyParser('json', { limit: MAX_REVIEW_CORRECTION_BODY_BYTES });

  const configService = app.get<ConfigService<Env, true>>(ConfigService);

  app.set('trust proxy', configService.get('TRUSTED_PROXY_HOPS'));

  return app;
}

async function bootstrap() {
  const app = await createApp();
  const configService = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(configService.get('PORT'));
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    startupLogger.fatal({ err: error }, 'Failed to start application');
    process.exit(1);
  });
}
