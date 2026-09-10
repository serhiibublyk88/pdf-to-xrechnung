import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import { reconcileStage } from '../queue/stranded-invoices';
import { GenerationQueue } from './generation-queue.service';

@Injectable()
export class GenerationReconciler implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generationQueue: GenerationQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GenerationReconciler.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await reconcileStage({
      prisma: this.prisma,
      queue: this.generationQueue,
      stage: PipelineStage.GENERATION,
      logger: this.logger,
      where: { status: { in: this.generationQueue.inFlightStatuses } },
      requeue: (invoice) =>
        this.generationQueue.requeueStranded({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
    });
  }
}
