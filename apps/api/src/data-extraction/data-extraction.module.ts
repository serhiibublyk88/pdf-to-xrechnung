import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { dlqQueueName, PipelineStage } from '../queue/pipeline-stage';
import { QueueModule } from '../queue/queue.module';
import { ValidationModule } from '../validation/validation.module';
import { DataExtractionProcessor } from './data-extraction.processor';
import { DataExtractionQueue } from './data-extraction-queue.service';
import { DataExtractionReconciler } from './data-extraction-reconciler.service';
import { ExtractionAttemptRunner } from './extraction-attempt.runner';
import { ExtractionModeController } from './extraction-mode.controller';
import { GeminiProvider } from './gemini-provider';
import { GroqProvider } from './groq-provider';
import { LLM_PROVIDER } from './llm-provider.interface';
import type { LlmProvider } from './llm-provider.interface';
import { MockProvider } from './mock-provider';
import { OllamaProvider } from './ollama-provider';

export function createLlmProvider(
  configService: ConfigService<Env, true>,
): LlmProvider {
  switch (configService.get('LLM_PROVIDER')) {
    case 'gemini':
      return new GeminiProvider(configService);
    case 'groq':
      return new GroqProvider(configService);
    case 'ollama':
      return new OllamaProvider(configService);
    case 'mock':
      return new MockProvider();
    default:
      throw new Error('Unsupported LLM provider configuration');
  }
}

@Module({
  imports: [
    QueueModule,
    ValidationModule,
    BullModule.registerQueue(
      { name: PipelineStage.DATA_EXTRACTION },
      { name: dlqQueueName(PipelineStage.DATA_EXTRACTION) },
    ),
  ],
  controllers: [ExtractionModeController],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: createLlmProvider,
    },
    ExtractionAttemptRunner,
    DataExtractionQueue,
    DataExtractionProcessor,
    DataExtractionReconciler,
  ],
  exports: [DataExtractionQueue],
})
export class DataExtractionModule {}
