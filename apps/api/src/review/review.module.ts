import { Module } from '@nestjs/common';
import { DataExtractionModule } from '../data-extraction/data-extraction.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { GenerationModule } from '../generation/generation.module';
import { QueueModule } from '../queue/queue.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { ValidationModule } from '../validation/validation.module';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [
    SessionsModule,
    ExtractionModule,
    DataExtractionModule,
    ValidationModule,
    GenerationModule,
    QueueModule,
    StorageModule,
  ],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
