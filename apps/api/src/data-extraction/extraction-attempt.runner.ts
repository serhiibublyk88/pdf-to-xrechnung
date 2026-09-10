import { Inject, Injectable } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildExtractionPrompt,
  buildRepairPrompt,
  PROMPT_VERSION,
} from './prompt';
import { LLM_PROVIDER } from './llm-provider.interface';
import type { LlmProvider, RawLlmResponse } from './llm-provider.interface';
import {
  RawExtractedInvoiceDataSchema,
  type RawExtractedInvoiceData,
} from '@pdf-to-xrechnung/contracts';

export interface ExtractionAttemptInput {
  invoiceId: string;
  storageKey: string;
  invoiceText: string;
}

export type ExtractionAttemptOutcome =
  | { status: 'parsed'; data: RawExtractedInvoiceData }
  | { status: 'failed'; failureKind: 'json' | 'schema' | 'truncated' }
  | { status: 'stale' };

type ParseResult =
  | { success: true; data: RawExtractedInvoiceData }
  | { success: false; kind: 'json' | 'schema'; error: string };

function parseResponse(text: string): ParseResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch (error) {
    return {
      success: false,
      kind: 'json',
      error: `Response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validated = RawExtractedInvoiceDataSchema.safeParse(candidate);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { success: false, kind: 'schema', error: issues };
  }

  return { success: true, data: validated.data };
}

@Injectable()
export class ExtractionAttemptRunner {
  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly prisma: PrismaService,
  ) {}

  async run({
    invoiceId,
    storageKey,
    invoiceText,
  }: ExtractionAttemptInput): Promise<ExtractionAttemptOutcome> {
    const first = await this.callAndPersist(
      invoiceId,
      storageKey,
      buildExtractionPrompt(invoiceText),
    );
    if (first.attemptId === null) {
      return { status: 'stale' };
    }
    const firstResult = parseResponse(first.response.text);
    await this.finalize(first.attemptId, firstResult);
    if (firstResult.success) {
      return { status: 'parsed', data: firstResult.data };
    }

    if (first.response.truncated) {
      return { status: 'failed', failureKind: 'truncated' };
    }

    const repair = await this.callAndPersist(
      invoiceId,
      storageKey,
      buildRepairPrompt(invoiceText, first.response.text, firstResult.error),
    );
    if (repair.attemptId === null) {
      return { status: 'stale' };
    }
    const repairResult = parseResponse(repair.response.text);
    await this.finalize(repair.attemptId, repairResult);

    if (repairResult.success) {
      return { status: 'parsed', data: repairResult.data };
    }
    if (repair.response.truncated) {
      return { status: 'failed', failureKind: 'truncated' };
    }
    return { status: 'failed', failureKind: repairResult.kind };
  }

  private async callAndPersist(
    invoiceId: string,
    storageKey: string,
    prompt: string,
  ): Promise<{ response: RawLlmResponse; attemptId: string | null }> {
    const startedAt = Date.now();
    const response = await this.provider.extract(prompt);
    const durationMs = Date.now() - startedAt;

    const attemptId = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          storageKey,
          status: InvoiceStatus.EXTRACTING_DATA,
          expiresAt: { gt: new Date() },
        },
        data: { status: InvoiceStatus.EXTRACTING_DATA },
      });
      if (count !== 1) {
        return null;
      }

      // attemptNumber is a hint; the unique constraint is the backstop, so a P2002 must surface.
      const attemptNumber =
        (await tx.extractionAttempt.count({
          where: { invoiceId, storageKey },
        })) + 1;
      const attempt = await tx.extractionAttempt.create({
        data: {
          invoiceId,
          storageKey,
          attemptNumber,
          provider: this.provider.name,
          model: this.provider.model,
          promptVersion: PROMPT_VERSION,
          rawResponse: response.text,
          durationMs,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        },
      });
      return attempt.id;
    });

    return { response, attemptId };
  }

  private async finalize(
    attemptId: string,
    validated: ParseResult,
  ): Promise<void> {
    await this.prisma.extractionAttempt.update({
      where: { id: attemptId },
      data: validated.success
        ? { parsedData: validated.data, parseError: null }
        : { parseError: validated.error },
    });
  }
}
