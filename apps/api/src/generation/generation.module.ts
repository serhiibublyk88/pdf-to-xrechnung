import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import { QueueModule } from '../queue/queue.module';
import { GenerationProcessor } from './generation.processor';
import { GenerationQueue } from './generation-queue.service';
import { GenerationReconciler } from './generation-reconciler.service';
import { KositClient } from './kosit-client';

@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue(
      { name: PipelineStage.GENERATION },
      { name: dlqQueueName(PipelineStage.GENERATION) },
    ),
  ],
  providers: [
    GenerationQueue,
    GenerationProcessor,
    GenerationReconciler,
    KositClient,
  ],
  exports: [GenerationQueue, KositClient],
})
export class GenerationModule {}
