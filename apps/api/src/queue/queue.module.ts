import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { InvoiceStateMachine } from './invoice-state-machine';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Env, true>) => ({
        prefix: configService.get('QUEUE_PREFIX'),
        connection: {
          url: configService.get('REDIS_URL'),
          maxRetriesPerRequest: null,
        },
      }),
    }),
  ],
  providers: [InvoiceStateMachine],
  exports: [BullModule, InvoiceStateMachine],
})
export class QueueModule {}
