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

export type GenerationJobData = LifecycleJobData;

export const GENERATION_RETRY_EXHAUSTED_FAILURE = {
  code: 'generation_retries_exhausted',
} satisfies InvoiceFailure;

@Injectable()
export class GenerationQueue extends PipelineStageQueue {
  constructor(
    @InjectQueue(PipelineStage.GENERATION) queue: Queue<GenerationJobData>,
    @InjectQueue(dlqQueueName(PipelineStage.GENERATION))
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
        stage: PipelineStage.GENERATION,
        claimFrom: InvoiceStatus.GENERATING,
        claimTo: InvoiceStatus.GENERATING_DOCUMENT,
        retryExhaustedFailure: GENERATION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.GENERATING,
      },
      configService.get('RETENTION_HOURS'),
      logger,
    );
  }
}
