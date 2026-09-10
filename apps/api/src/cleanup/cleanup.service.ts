import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import {
  dlqQueueName,
  lifecycleJobIdFor,
  PipelineStage,
} from '../queue/pipeline-stage';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';

const INTERVAL_NAME = 'invoice-cleanup';
const BATCH_SIZE = 100;

interface StageQueues {
  stage: PipelineStage;
  queue: Pick<Queue, 'clean'>;
  dlq: Pick<Queue, 'getJob' | 'clean'>;
}

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly intervalMinutes: number;
  private readonly retentionMs: number;
  private readonly stages: StageQueues[];
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService<Env, true>,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @InjectQueue(PipelineStage.TEXT_EXTRACTION)
    textExtractionQueue: Pick<Queue, 'clean'>,
    @InjectQueue(dlqQueueName(PipelineStage.TEXT_EXTRACTION))
    textExtractionDlq: Pick<Queue, 'getJob' | 'clean'>,
    @InjectQueue(PipelineStage.DATA_EXTRACTION)
    dataExtractionQueue: Pick<Queue, 'clean'>,
    @InjectQueue(dlqQueueName(PipelineStage.DATA_EXTRACTION))
    dataExtractionDlq: Pick<Queue, 'getJob' | 'clean'>,
    @InjectQueue(PipelineStage.VALIDATION)
    validationQueue: Pick<Queue, 'clean'>,
    @InjectQueue(dlqQueueName(PipelineStage.VALIDATION))
    validationDlq: Pick<Queue, 'getJob' | 'clean'>,
    @InjectQueue(PipelineStage.GENERATION)
    generationQueue: Pick<Queue, 'clean'>,
    @InjectQueue(dlqQueueName(PipelineStage.GENERATION))
    generationDlq: Pick<Queue, 'getJob' | 'clean'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CleanupService.name);
    this.intervalMinutes = configService.get('CLEANUP_INTERVAL_MINUTES');
    this.retentionMs = configService.get('RETENTION_HOURS') * 60 * 60 * 1000;
    this.stages = [
      {
        stage: PipelineStage.TEXT_EXTRACTION,
        queue: textExtractionQueue,
        dlq: textExtractionDlq,
      },
      {
        stage: PipelineStage.DATA_EXTRACTION,
        queue: dataExtractionQueue,
        dlq: dataExtractionDlq,
      },
      {
        stage: PipelineStage.VALIDATION,
        queue: validationQueue,
        dlq: validationDlq,
      },
      {
        stage: PipelineStage.GENERATION,
        queue: generationQueue,
        dlq: generationDlq,
      },
    ];
  }

  onModuleInit(): void {
    const intervalMs = this.intervalMinutes * 60 * 1000;
    const interval = setInterval(() => {
      this.run().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Cleanup run failed');
      });
    }, intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
  }

  onModuleDestroy(): void {
    this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
  }

  async run(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      const pendingDeletions =
        await this.prisma.pendingStorageDeletion.findMany({
          select: { storageKey: true },
          take: BATCH_SIZE,
        });
      let deletedFiles = 0;
      for (const pendingDeletion of pendingDeletions) {
        try {
          await this.storage.delete(pendingDeletion.storageKey);
          const { count } = await this.prisma.pendingStorageDeletion.deleteMany(
            { where: { storageKey: pendingDeletion.storageKey } },
          );
          if (count === 1) {
            deletedFiles++;
          }
        } catch (error) {
          this.logger.error(
            { err: error },
            'Failed to clean up pending stored file',
          );
        }
      }

      if (deletedFiles > 0) {
        this.logger.info({ deletedFiles }, 'Cleaned up pending stored files');
      }

      const cutoff = new Date();
      const expired = await this.prisma.invoice.findMany({
        where: { expiresAt: { lte: cutoff } },
        select: { id: true, storageKey: true },
        take: BATCH_SIZE,
      });

      let cleaned = 0;
      for (const invoice of expired) {
        try {
          await this.storage.delete(invoice.storageKey);
          const { count } = await this.prisma.invoice.deleteMany({
            where: {
              id: invoice.id,
              storageKey: invoice.storageKey,
              expiresAt: { lte: cutoff },
            },
          });
          if (count === 1) {
            cleaned++;
            await this.removeDlqEntry(invoice.id, invoice.storageKey);
          }
        } catch (error) {
          this.logger.error(
            { err: error, invoiceId: invoice.id },
            'Failed to clean up invoice',
          );
        }
      }

      if (cleaned > 0) {
        this.logger.info({ cleaned }, 'Cleaned up expired invoices');
      }

      await Promise.all(
        this.stages.flatMap(({ stage, queue, dlq }) => [
          queue
            .clean(this.retentionMs, 1000, 'failed')
            .catch((error: unknown) => {
              this.logger.error(
                { err: error, stage },
                'Primary queue sweep failed',
              );
            }),
          dlq.clean(this.retentionMs, 1000, 'wait').catch((error: unknown) => {
            this.logger.error(
              { err: error, stage },
              'Dead-letter queue sweep failed',
            );
          }),
        ]),
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async removeDlqEntry(
    invoiceId: string,
    storageKey: string,
  ): Promise<void> {
    await Promise.all(
      this.stages.map(({ stage, dlq }) =>
        this.removeDlqEntryFrom(dlq, stage, invoiceId, storageKey),
      ),
    );
  }

  private async removeDlqEntryFrom(
    dlq: Pick<Queue, 'getJob'>,
    stage: PipelineStage,
    invoiceId: string,
    storageKey: string,
  ): Promise<void> {
    try {
      const job = await dlq.getJob(
        lifecycleJobIdFor(stage, invoiceId, storageKey),
      );
      await job?.remove();
    } catch (error) {
      this.logger.error(
        { err: error, invoiceId, stage },
        'Failed to remove dead-letter entry',
      );
    }
  }
}
