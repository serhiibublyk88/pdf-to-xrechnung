import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineStage } from '../queue/pipeline-stage';
import { reconcileStage } from '../queue/stranded-invoices';
import { ValidationQueue } from './validation-queue.service';

@Injectable()
export class ValidationReconciler implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validationQueue: ValidationQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ValidationReconciler.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await reconcileStage({
      prisma: this.prisma,
      queue: this.validationQueue,
      stage: PipelineStage.VALIDATION,
      logger: this.logger,
      where: { status: { in: this.validationQueue.inFlightStatuses } },
      requeue: (invoice) =>
        this.validationQueue.requeueStranded({
          invoiceId: invoice.id,
          storageKey: invoice.storageKey,
        }),
    });
  }
}
