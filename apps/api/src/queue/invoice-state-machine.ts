import { Injectable } from '@nestjs/common';
import type { InvoiceFailure } from '@pdf-to-xrechnung/contracts';
import { InvoiceStatus, Prisma, SourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface TransitionPatch {
  failure?: InvoiceFailure;
  sourceType?: SourceType;
  pageCount?: number | null;
  extractedText?: string | null;
  textCharCount?: number | null;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly invoiceId: string,
    readonly from: InvoiceStatus,
    readonly to: InvoiceStatus,
  ) {
    super(
      `Invoice ${invoiceId} cannot transition from ${from} to ${to}: not a legal transition`,
    );
  }
}

export type TransitionOutcome = 'claimed' | 'lost';

export type ReviewCorrectionOutcome =
  { outcome: 'claimed'; reviewVersion: number } | { outcome: 'lost' };

export const LEGAL_TRANSITIONS: Partial<
  Record<InvoiceStatus, InvoiceStatus[]>
> = {
  [InvoiceStatus.UPLOADED]: [InvoiceStatus.EXTRACTING_TEXT],
  [InvoiceStatus.EXTRACTING_TEXT]: [
    InvoiceStatus.TEXT_READY,
    InvoiceStatus.FAILED,
  ],
  [InvoiceStatus.TEXT_READY]: [
    InvoiceStatus.EXTRACTING_DATA,
    InvoiceStatus.EXTRACTING_TEXT,
  ],
  [InvoiceStatus.EXTRACTING_DATA]: [
    InvoiceStatus.DATA_READY,
    InvoiceStatus.FAILED,
  ],
  [InvoiceStatus.DATA_READY]: [
    InvoiceStatus.VALIDATING,
    InvoiceStatus.EXTRACTING_DATA,
  ],
  [InvoiceStatus.VALIDATING]: [
    InvoiceStatus.NEEDS_REVIEW,
    InvoiceStatus.GENERATING,
  ],
  [InvoiceStatus.NEEDS_REVIEW]: [
    InvoiceStatus.NEEDS_REVIEW,
    InvoiceStatus.GENERATING,
  ],
  [InvoiceStatus.GENERATING]: [
    InvoiceStatus.GENERATING_DOCUMENT,
    InvoiceStatus.NEEDS_REVIEW,
    InvoiceStatus.VALIDATING,
  ],
  [InvoiceStatus.GENERATING_DOCUMENT]: [
    InvoiceStatus.NEEDS_REVIEW,
    InvoiceStatus.READY,
  ],
  [InvoiceStatus.FAILED]: [
    InvoiceStatus.EXTRACTING_TEXT,
    InvoiceStatus.EXTRACTING_DATA,
    InvoiceStatus.VALIDATING,
    InvoiceStatus.GENERATING,
  ],
};

@Injectable()
export class InvoiceStateMachine {
  constructor(private readonly prisma: PrismaService) {}

  private assertLegalTransition(
    invoiceId: string,
    from: InvoiceStatus,
    to: InvoiceStatus,
  ): void {
    if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
      throw new IllegalTransitionError(invoiceId, from, to);
    }
  }

  private async claimLifecycle(
    tx: Prisma.TransactionClient,
    {
      invoiceId,
      storageKey,
      from,
      to,
      data = {},
    }: {
      invoiceId: string;
      storageKey: string;
      from: InvoiceStatus;
      to: InvoiceStatus;
      data?: Prisma.InvoiceUpdateManyMutationInput;
    },
  ): Promise<boolean> {
    const { count } = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        storageKey,
        status: from,
        expiresAt: { gt: new Date() },
      },
      data: { ...data, status: to },
    });
    return count === 1;
  }

  private async claimAndReplaceFindings({
    invoiceId,
    storageKey,
    from,
    to,
    data = {},
    scope,
    findings,
    extra,
  }: {
    invoiceId: string;
    storageKey: string;
    from: InvoiceStatus;
    to: InvoiceStatus;
    data?: Prisma.InvoiceUpdateManyMutationInput;
    scope: Prisma.ValidationResultWhereInput;
    findings: Omit<Prisma.ValidationResultCreateManyInput, 'invoiceId'>[];
    extra?: (tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<TransitionOutcome> {
    this.assertLegalTransition(invoiceId, from, to);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await this.claimLifecycle(tx, {
        invoiceId,
        storageKey,
        from,
        to,
        data,
      });
      if (!claimed) {
        return 'lost';
      }

      await tx.validationResult.deleteMany({
        where: { invoiceId, ...scope },
      });
      await tx.validationResult.createMany({
        data: findings.map((finding) => ({ ...finding, invoiceId })),
      });
      if (extra) {
        await extra(tx);
      }
      return 'claimed';
    });
  }

  async transition({
    invoiceId,
    storageKey,
    from,
    to,
    data = {},
  }: {
    invoiceId: string;
    storageKey: string;
    from: InvoiceStatus;
    to: InvoiceStatus;
    data?: TransitionPatch;
  }): Promise<TransitionOutcome> {
    this.assertLegalTransition(invoiceId, from, to);
    const { failure, ...patch } = data;
    if (to === InvoiceStatus.FAILED && !failure) {
      throw new Error(
        `Invoice ${invoiceId}: transition from ${from} to FAILED requires a failure`,
      );
    }
    if (to !== InvoiceStatus.FAILED && failure) {
      throw new Error(
        `Invoice ${invoiceId}: transition from ${from} to ${to} must not carry a failure`,
      );
    }
    if (to === InvoiceStatus.TEXT_READY && !patch.extractedText) {
      throw new Error(
        `Invoice ${invoiceId}: transition from ${from} to TEXT_READY requires non-empty extractedText`,
      );
    }
    const failurePatch = failure
      ? {
          failureCode: failure.code,
          failureParams: 'params' in failure ? failure.params : Prisma.DbNull,
        }
      : {};

    const claimed = await this.claimLifecycle(this.prisma, {
      invoiceId,
      storageKey,
      from,
      to,
      data: { ...patch, ...failurePatch },
    });
    return claimed ? 'claimed' : 'lost';
  }

  async failIrrecoverably({
    invoiceId,
    storageKey,
    from,
    failure,
  }: {
    invoiceId: string;
    storageKey: string;
    from: InvoiceStatus[];
    failure: InvoiceFailure;
  }): Promise<TransitionOutcome> {
    const { count } = await this.prisma.invoice.updateMany({
      where: {
        id: invoiceId,
        storageKey,
        status: { in: from },
        expiresAt: { gt: new Date() },
      },
      data: {
        status: InvoiceStatus.FAILED,
        failureCode: failure.code,
        failureParams: 'params' in failure ? failure.params : Prisma.DbNull,
      },
    });
    if (count === 1) {
      return 'claimed';
    }

    const alreadyFailed = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        storageKey,
        status: InvoiceStatus.FAILED,
        failureCode: failure.code,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return alreadyFailed !== null ? 'claimed' : 'lost';
  }

  async completeValidation({
    invoiceId,
    storageKey,
    to,
    validationResults,
  }: {
    invoiceId: string;
    storageKey: string;
    to: typeof InvoiceStatus.NEEDS_REVIEW | typeof InvoiceStatus.GENERATING;
    validationResults: Omit<
      Prisma.ValidationResultCreateManyInput,
      'invoiceId'
    >[];
  }): Promise<TransitionOutcome> {
    return this.claimAndReplaceFindings({
      invoiceId,
      storageKey,
      from: InvoiceStatus.VALIDATING,
      to,
      scope: {},
      findings: validationResults,
    });
  }

  async reviewCorrection({
    invoiceId,
    storageKey,
    expectedReviewVersion,
    correctedData,
    findings,
    to,
  }: {
    invoiceId: string;
    storageKey: string;
    expectedReviewVersion: number;
    correctedData: Prisma.InputJsonValue;
    findings: Omit<Prisma.ValidationResultCreateManyInput, 'invoiceId'>[];
    to: typeof InvoiceStatus.NEEDS_REVIEW | typeof InvoiceStatus.GENERATING;
  }): Promise<ReviewCorrectionOutcome> {
    this.assertLegalTransition(invoiceId, InvoiceStatus.NEEDS_REVIEW, to);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          storageKey,
          status: InvoiceStatus.NEEDS_REVIEW,
          reviewVersion: expectedReviewVersion,
          expiresAt: { gt: new Date() },
        },
        data: {
          reviewedData: correctedData,
          reviewedAt: new Date(),
          reviewVersion: { increment: 1 },
          status: to,
        },
      });
      if (count === 0) {
        return { outcome: 'lost' };
      }

      await tx.validationResult.deleteMany({ where: { invoiceId } });
      await tx.validationResult.createMany({
        data: findings.map((finding) => ({ ...finding, invoiceId })),
      });
      await tx.generatedDocument.deleteMany({ where: { invoiceId } });

      return {
        outcome: 'claimed',
        reviewVersion: expectedReviewVersion + 1,
      };
    });
  }

  async rejectGeneration({
    invoiceId,
    storageKey,
    findings,
  }: {
    invoiceId: string;
    storageKey: string;
    findings: Omit<Prisma.ValidationResultCreateManyInput, 'invoiceId'>[];
  }): Promise<TransitionOutcome> {
    return this.claimAndReplaceFindings({
      invoiceId,
      storageKey,
      from: InvoiceStatus.GENERATING_DOCUMENT,
      to: InvoiceStatus.NEEDS_REVIEW,
      scope: { rule: { startsWith: 'mapping.' } },
      findings,
    });
  }

  async completeGeneration({
    invoiceId,
    storageKey,
    to,
    document,
    findings,
  }: {
    invoiceId: string;
    storageKey: string;
    to: typeof InvoiceStatus.NEEDS_REVIEW | typeof InvoiceStatus.READY;
    document: Omit<Prisma.GeneratedDocumentCreateManyInput, 'invoiceId'>;
    findings: Omit<Prisma.ValidationResultCreateManyInput, 'invoiceId'>[];
  }): Promise<TransitionOutcome> {
    return this.claimAndReplaceFindings({
      invoiceId,
      storageKey,
      from: InvoiceStatus.GENERATING_DOCUMENT,
      to,
      scope: { rule: { startsWith: 'kosit.' } },
      findings,
      extra: async (tx) => {
        await tx.generatedDocument.create({ data: { ...document, invoiceId } });
      },
    });
  }

  async reopenAfterDeadLetter({
    invoiceId,
    storageKey,
    to,
  }: {
    invoiceId: string;
    storageKey: string;
    to: InvoiceStatus;
  }): Promise<TransitionOutcome> {
    this.assertLegalTransition(invoiceId, InvoiceStatus.FAILED, to);

    const { count } = await this.prisma.invoice.updateMany({
      where: {
        id: invoiceId,
        storageKey,
        status: InvoiceStatus.FAILED,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: to,
        failureCode: null,
        failureParams: Prisma.DbNull,
      },
    });
    if (count === 1) {
      return 'claimed';
    }

    const alreadyReopened = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        storageKey,
        status: to,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return alreadyReopened !== null ? 'claimed' : 'lost';
  }
}
