import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import { reconcileStage } from '../queue/stranded-invoices';
import { DataExtractionQueue } from './data-extraction-queue.service';

@Injectable()
export class DataExtractionReconciler implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataExtractionQueue: DataExtractionQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DataExtractionReconciler.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await reconcileStage({
      prisma: this.prisma,
      queue: this.dataExtractionQueue,
      stage: PipelineStage.DATA_EXTRACTION,
      logger: this.logger,
      where: { status: { in: this.dataExtractionQueue.inFlightStatuses } },
      requeue: (invoice) =>
        this.dataExtractionQueue.requeueStranded({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
    });
  }
}
