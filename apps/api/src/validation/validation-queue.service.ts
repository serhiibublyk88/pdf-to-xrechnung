import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';
import { ConfigService } from '@nestjs/config';
import { InvoiceStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStateMachine } from '../queue/invoice-state-machine';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import {
  PipelineStageQueue,
  type DeadLetterJobData,
  type LifecycleJobData,
} from '../queue/pipeline-stage-queue';

export type ValidationJobData = LifecycleJobData;

export const VALIDATION_RETRY_EXHAUSTED_FAILURE = {
  code: 'validation_retries_exhausted',
} satisfies InvoiceFailure;

@Injectable()
export class ValidationQueue extends PipelineStageQueue {
  constructor(
    @InjectQueue(PipelineStage.VALIDATION) queue: Queue<ValidationJobData>,
    @InjectQueue(dlqQueueName(PipelineStage.VALIDATION))
    dlq: Queue<DeadLetterJobData>,
    stateMachine: InvoiceStateMachine,
    prisma: PrismaService,
    configService: ConfigService<Env, true>,
    logger: PinoLogger,
  ) {
    super(
      queue,
      dlq,
      stateMachine,
      prisma,
      {
        stage: PipelineStage.VALIDATION,
        claimFrom: InvoiceStatus.DATA_READY,
        claimTo: InvoiceStatus.VALIDATING,
        retryExhaustedFailure: VALIDATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.VALIDATING,
      },
      configService.get('RETENTION_HOURS'),
      logger,
    );
  }
}
