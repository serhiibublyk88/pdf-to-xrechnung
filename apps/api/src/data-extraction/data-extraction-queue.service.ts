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

export type DataExtractionJobData = LifecycleJobData;

export const DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE = {
  code: 'data_extraction_retries_exhausted',
} satisfies InvoiceFailure;

@Injectable()
export class DataExtractionQueue extends PipelineStageQueue {
  constructor(
    @InjectQueue(PipelineStage.DATA_EXTRACTION)
    queue: Queue<DataExtractionJobData>,
    @InjectQueue(dlqQueueName(PipelineStage.DATA_EXTRACTION))
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
        stage: PipelineStage.DATA_EXTRACTION,
        claimFrom: InvoiceStatus.TEXT_READY,
        claimTo: InvoiceStatus.EXTRACTING_DATA,
        retryExhaustedFailure: DATA_EXTRACTION_RETRY_EXHAUSTED_FAILURE,
        reopenTo: InvoiceStatus.EXTRACTING_DATA,
      },
      configService.get('RETENTION_HOURS'),
      logger,
    );
  }
}
