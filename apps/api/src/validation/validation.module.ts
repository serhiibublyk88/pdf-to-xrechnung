import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { GenerationModule } from '../generation/generation.module';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import { QueueModule } from '../queue/queue.module';
import { ValidationProcessor } from './validation.processor';
import { ValidationQueue } from './validation-queue.service';
import { ValidationReconciler } from './validation-reconciler.service';

@Module({
  imports: [
    QueueModule,
    GenerationModule,
    BullModule.registerQueue(
      { name: PipelineStage.VALIDATION },
      { name: dlqQueueName(PipelineStage.VALIDATION) },
    ),
  ],
  providers: [ValidationQueue, ValidationProcessor, ValidationReconciler],
  exports: [ValidationQueue],
})
export class ValidationModule {}
