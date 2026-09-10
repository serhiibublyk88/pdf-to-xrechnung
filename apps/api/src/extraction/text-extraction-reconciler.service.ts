import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import { reconcileStage } from '../queue/stranded-invoices';
import { STORAGE_SERVICE } from '../storage/storage.interface';
import type { StorageService } from '../storage/storage.interface';
import { TextExtractionQueue } from './text-extraction-queue.service';

@Injectable()
export class TextExtractionReconciler implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly textExtractionQueue: TextExtractionQueue,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TextExtractionReconciler.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await reconcileStage({
      prisma: this.prisma,
      queue: this.textExtractionQueue,
      stage: PipelineStage.TEXT_EXTRACTION,
      logger: this.logger,
      where: { status: { in: this.textExtractionQueue.inFlightStatuses } },
      requeue: async (invoice) => {
        if (
          invoice.status === InvoiceStatus.UPLOADED &&
          !(await this.storage.exists(invoice.storageKey))
        ) {
          this.logger.debug(
            { invoiceId: invoice.id, stage: PipelineStage.TEXT_EXTRACTION },
            'Skipping reconciliation: stored file not found',
          );
          return false;
        }
        return this.textExtractionQueue.requeueStranded({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        });
      },
    });
  }
}
