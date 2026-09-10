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

export type TextExtractionJobData = LifecycleJobData;

export const TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE = {
  code: 'text_extraction_retries_exhausted',
} satisfies InvoiceFailure;

@Injectable()
export class TextExtractionQueue extends PipelineStageQueue {
  constructor(
    @InjectQueue(PipelineStage.TEXT_EXTRACTION)
    queue: Queue<TextExtractionJobData>,
    @InjectQueue(dlqQueueName(PipelineStage.TEXT_EXTRACTION))
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
        stage: PipelineStage.TEXT_EXTRACTION,
        claimFrom: InvoiceStatus.UPLOADED,
        claimTo: InvoiceStatus.EXTRACTING_TEXT,
        retryExhaustedFailure: TEXT_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_TEXT,
      },
      configService.get('RETENTION_HOURS'),
      logger,
    );
  }
}
