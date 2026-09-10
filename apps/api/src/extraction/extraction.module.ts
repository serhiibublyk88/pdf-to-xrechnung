import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DataExtractionModule } from '../data-extraction/data-extraction.module';
import { QueueModule } from '../queue/queue.module';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import { StorageModule } from '../storage/storage.module';
import { NativeTextExtractor } from './native-text-extractor';
import { OcrTextExtractor } from './ocr-text-extractor';
import { TextExtractionProcessor } from './text-extraction.processor';
import { TextExtractionQueue } from './text-extraction-queue.service';
import { TextExtractionReconciler } from './text-extraction-reconciler.service';
import { TEXT_EXTRACTOR } from './text-extractor.interface';

@Module({
  imports: [
    StorageModule,
    QueueModule,
    DataExtractionModule,
    BullModule.registerQueue(
      { name: PipelineStage.TEXT_EXTRACTION },
      { name: dlqQueueName(PipelineStage.TEXT_EXTRACTION) },
    ),
  ],
  providers: [
    { provide: TEXT_EXTRACTOR, useClass: NativeTextExtractor },
    OcrTextExtractor,
    TextExtractionQueue,
    TextExtractionProcessor,
    TextExtractionReconciler,
  ],
  exports: [TEXT_EXTRACTOR, TextExtractionQueue],
})
export class ExtractionModule {}
