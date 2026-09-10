import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { CleanupService } from './cleanup.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    StorageModule,
    QueueModule,
    BullModule.registerQueue(
      { name: PipelineStage.TEXT_EXTRACTION },
      { name: dlqQueueName(PipelineStage.TEXT_EXTRACTION) },
      { name: PipelineStage.DATA_EXTRACTION },
      { name: dlqQueueName(PipelineStage.DATA_EXTRACTION) },
      { name: PipelineStage.VALIDATION },
      { name: dlqQueueName(PipelineStage.VALIDATION) },
      { name: PipelineStage.GENERATION },
      { name: dlqQueueName(PipelineStage.GENERATION) },
    ),
  ],
  providers: [CleanupService],
})
export class CleanupModule {}
