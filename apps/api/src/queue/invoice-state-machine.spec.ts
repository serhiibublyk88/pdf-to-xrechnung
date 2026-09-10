import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  IllegalTransitionError,
  InvoiceStateMachine,
  LEGAL_TRANSITIONS,
} from './invoice-state-machine';

describe('InvoiceStateMachine', () => {
  let stateMachine: InvoiceStateMachine;
  let prisma: {
    invoice: {
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    validationResult: { deleteMany: jest.Mock; createMany: jest.Mock };
    generatedDocument: { create: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    const tx = {
      invoice: {
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
      validationResult: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      generatedDocument: {
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    prisma = {
      invoice: tx.invoice,
      validationResult: tx.validationResult,
      generatedDocument: tx.generatedDocument,
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceStateMachine,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    stateMachine = module.get(InvoiceStateMachine);
  });

  it('applies a legal transition as a single conditional update', async () => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.EXTRACTING_TEXT,
      }),
    ).resolves.toBe('claimed');

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invoice-1',
        storageKey: 'storage-key-1',
        status: InvoiceStatus.UPLOADED,
        expiresAt: { gt: expect.any(Date) as Date },
      },
      data: { status: InvoiceStatus.EXTRACTING_TEXT },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('passes extra fields through alongside the status change', async () => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await stateMachine.transition({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from: InvoiceStatus.EXTRACTING_TEXT,
      to: InvoiceStatus.FAILED,
      data: { failure: { code: 'pdf_no_pages' } },
    });

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invoice-1',
        storageKey: 'storage-key-1',
        status: InvoiceStatus.EXTRACTING_TEXT,
        expiresAt: { gt: expect.any(Date) as Date },
      },
      data: {
        failureCode: 'pdf_no_pages',
        failureParams: Prisma.DbNull,
        status: InvoiceStatus.FAILED,
      },
    });
  });

  it('rejects a transition to FAILED with no failure, before touching the database', async () => {
    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_TEXT,
        to: InvoiceStatus.FAILED,
      }),
    ).rejects.toThrow();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a legal non-FAILED transition that carries a failure patch, before touching the database', async () => {
    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.EXTRACTING_TEXT,
        data: { failure: { code: 'pdf_no_pages' } },
      }),
    ).rejects.toThrow();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [InvoiceStatus.TEXT_READY, InvoiceStatus.EXTRACTING_DATA],
    [InvoiceStatus.EXTRACTING_DATA, InvoiceStatus.DATA_READY],
    [InvoiceStatus.DATA_READY, InvoiceStatus.VALIDATING],
    [InvoiceStatus.VALIDATING, InvoiceStatus.NEEDS_REVIEW],
    [InvoiceStatus.VALIDATING, InvoiceStatus.GENERATING],
    [InvoiceStatus.NEEDS_REVIEW, InvoiceStatus.NEEDS_REVIEW],
    [InvoiceStatus.NEEDS_REVIEW, InvoiceStatus.GENERATING],
    [InvoiceStatus.GENERATING, InvoiceStatus.GENERATING_DOCUMENT],
    [InvoiceStatus.GENERATING, InvoiceStatus.NEEDS_REVIEW],
    [InvoiceStatus.GENERATING_DOCUMENT, InvoiceStatus.NEEDS_REVIEW],
    [InvoiceStatus.GENERATING_DOCUMENT, InvoiceStatus.READY],
    [InvoiceStatus.DATA_READY, InvoiceStatus.EXTRACTING_DATA],
    [InvoiceStatus.GENERATING, InvoiceStatus.VALIDATING],
    [InvoiceStatus.TEXT_READY, InvoiceStatus.EXTRACTING_TEXT],
  ])('allows the legal transition %s -> %s', async (from, to) => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from,
        to,
      }),
    ).resolves.toBe('claimed');
  });

  it('rejects a transition to TEXT_READY with no extractedText, before touching the database', async () => {
    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_TEXT,
        to: InvoiceStatus.TEXT_READY,
        data: { extractedText: null },
      }),
    ).rejects.toThrow();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a transition to TEXT_READY with an empty extractedText, before touching the database', async () => {
    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_TEXT,
        to: InvoiceStatus.TEXT_READY,
        data: { extractedText: '' },
      }),
    ).rejects.toThrow();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('allows a transition to TEXT_READY carrying non-empty extractedText', async () => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.EXTRACTING_TEXT,
        to: InvoiceStatus.TEXT_READY,
        data: { extractedText: 'Rechnung Nr. RE-1' },
      }),
    ).resolves.toBe('claimed');
  });

  it('rejects a transition not in the legal table without touching the database', async () => {
    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.TEXT_READY,
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('has exactly the edges the pipeline actually uses, and nothing else', () => {
    expect(LEGAL_TRANSITIONS).toEqual({
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
    });
  });

  it.each(
    Object.values(InvoiceStatus).flatMap((from) =>
      Object.values(InvoiceStatus).map(
        (to) =>
          [from, to, (LEGAL_TRANSITIONS[from] ?? []).includes(to)] as const,
      ),
    ),
  )('%s -> %s is %s', async (from, to, legal) => {
    prisma.invoice.updateMany.mockResolvedValue({ count: legal ? 1 : 0 });

    const attempt = stateMachine.transition({
      invoiceId: 'invoice-1',
      storageKey: 'storage-key-1',
      from,
      to,
      data:
        to === InvoiceStatus.FAILED
          ? { failure: { code: 'pdf_no_pages' as const } }
          : to === InvoiceStatus.TEXT_READY
            ? { extractedText: 'Rechnung Nr. RE-1' }
            : {},
    });

    if (legal) {
      await expect(attempt).resolves.toBe('claimed');
    } else {
      await expect(attempt).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    }
  });

  it('returns a lost outcome, without throwing, when a legal-in-principle transition finds the row already moved on', async () => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      stateMachine.transition({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: InvoiceStatus.UPLOADED,
        to: InvoiceStatus.EXTRACTING_TEXT,
      }),
    ).resolves.toBe('lost');
  });

  describe('failIrrecoverably', () => {
    it('fails the current lifecycle from a caller-supplied set of statuses', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        stateMachine.failIrrecoverably({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          from: [InvoiceStatus.UPLOADED, InvoiceStatus.EXTRACTING_TEXT],
          failure: { code: 'text_extraction_retries_exhausted' },
        }),
      ).resolves.toBe('claimed');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: {
            in: [InvoiceStatus.UPLOADED, InvoiceStatus.EXTRACTING_TEXT],
          },
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: {
          status: InvoiceStatus.FAILED,
          failureCode: 'text_extraction_retries_exhausted',
          failureParams: Prisma.DbNull,
        },
      });
    });

    it('scopes the eligible statuses to exactly what the caller passed, for a different stage', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await stateMachine.failIrrecoverably({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        from: [InvoiceStatus.EXTRACTING_DATA],
        failure: { code: 'text_extraction_retries_exhausted' },
      });

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: { in: [InvoiceStatus.EXTRACTING_DATA] },
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: {
          status: InvoiceStatus.FAILED,
          failureCode: 'text_extraction_retries_exhausted',
          failureParams: Prisma.DbNull,
        },
      });
    });

    it('accepts a concurrent failure with the same code and different parameters', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoice.findFirst.mockResolvedValue({ id: 'invoice-1' });

      await expect(
        stateMachine.failIrrecoverably({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          from: [InvoiceStatus.UPLOADED, InvoiceStatus.EXTRACTING_TEXT],
          failure: {
            code: 'pdf_too_many_pages',
            params: { pageCount: 31, limit: 30 },
          },
        }),
      ).resolves.toBe('claimed');
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: InvoiceStatus.FAILED,
          failureCode: 'pdf_too_many_pages',
          expiresAt: { gt: expect.any(Date) as Date },
        },
        select: { id: true },
      });
    });

    it('rejects a failure from a stale lifecycle', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoice.findFirst.mockResolvedValue(null);

      await expect(
        stateMachine.failIrrecoverably({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          from: [InvoiceStatus.UPLOADED, InvoiceStatus.EXTRACTING_TEXT],
          failure: { code: 'text_extraction_retries_exhausted' },
        }),
      ).resolves.toBe('lost');
    });
  });

  describe('completeValidation', () => {
    it('persists validation results with the current lifecycle and final status atomically', async () => {
      const now = new Date('2026-08-10T12:00:00.000Z');
      jest.useFakeTimers({ now });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.validationResult.deleteMany.mockResolvedValue({ count: 0 });
      prisma.validationResult.createMany.mockResolvedValue({ count: 1 });

      try {
        await expect(
          stateMachine.completeValidation({
            invoiceId: 'invoice-1',
            storageKey: 'storage-key-1',
            to: InvoiceStatus.NEEDS_REVIEW,
            validationResults: [
              {
                rule: 'arithmetic.gross',
                field: 'grossTotal',
                severity: 'ERROR',
                passed: false,
                message: 'Gross total does not match the expected amount.',
                expected: '119.00',
                actual: '120.00',
              },
            ],
          }),
        ).resolves.toBe('claimed');

        expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'invoice-1',
            storageKey: 'storage-key-1',
            status: InvoiceStatus.VALIDATING,
            expiresAt: { gt: now },
          },
          data: { status: InvoiceStatus.NEEDS_REVIEW },
        });
        expect(prisma.validationResult.deleteMany).toHaveBeenCalledWith({
          where: { invoiceId: 'invoice-1' },
        });
        expect(prisma.validationResult.createMany).toHaveBeenCalledWith({
          data: [
            {
              invoiceId: 'invoice-1',
              rule: 'arithmetic.gross',
              field: 'grossTotal',
              severity: 'ERROR',
              passed: false,
              message: 'Gross total does not match the expected amount.',
              expected: '119.00',
              actual: '120.00',
            },
          ],
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not write results when the validation lifecycle is stale or expired', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        stateMachine.completeValidation({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          to: InvoiceStatus.NEEDS_REVIEW,
          validationResults: [
            {
              rule: 'arithmetic.gross',
              field: 'grossTotal',
              severity: 'ERROR',
              passed: false,
              message: 'Gross total does not match the expected amount.',
            },
          ],
        }),
      ).resolves.toBe('lost');

      expect(prisma.validationResult.deleteMany).not.toHaveBeenCalled();
      expect(prisma.validationResult.createMany).not.toHaveBeenCalled();
    });
  });

  describe('reviewCorrection', () => {
    it('persists the correction, replaces findings and any stale document, and moves to GENERATING', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.validationResult.deleteMany.mockResolvedValue({ count: 1 });
      prisma.validationResult.createMany.mockResolvedValue({ count: 1 });
      prisma.generatedDocument.deleteMany.mockResolvedValue({ count: 1 });

      await expect(
        stateMachine.reviewCorrection({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          expectedReviewVersion: 0,
          correctedData: { invoiceNumber: 'RE-2026-001' },
          findings: [
            {
              rule: 'mandatory.invoice_number',
              field: 'invoiceNumber',
              severity: 'ERROR',
              passed: true,
              message: 'Invoice number is present.',
            },
          ],
          to: InvoiceStatus.GENERATING,
        }),
      ).resolves.toEqual({ outcome: 'claimed', reviewVersion: 1 });

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: InvoiceStatus.NEEDS_REVIEW,
          reviewVersion: 0,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: {
          reviewedData: { invoiceNumber: 'RE-2026-001' },
          reviewedAt: expect.any(Date) as Date,
          reviewVersion: { increment: 1 },
          status: InvoiceStatus.GENERATING,
        },
      });
      expect(prisma.validationResult.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: 'invoice-1' },
      });
      expect(prisma.generatedDocument.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: 'invoice-1' },
      });
      expect(prisma.validationResult.createMany).toHaveBeenCalledWith({
        data: [
          {
            invoiceId: 'invoice-1',
            rule: 'mandatory.invoice_number',
            field: 'invoiceNumber',
            severity: 'ERROR',
            passed: true,
            message: 'Invoice number is present.',
          },
        ],
      });
    });

    it('does not write a correction when the review lifecycle is stale or expired', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        stateMachine.reviewCorrection({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          expectedReviewVersion: 0,
          correctedData: { invoiceNumber: 'RE-2026-001' },
          findings: [],
          to: InvoiceStatus.GENERATING,
        }),
      ).resolves.toEqual({ outcome: 'lost' });

      expect(prisma.validationResult.deleteMany).not.toHaveBeenCalled();
      expect(prisma.generatedDocument.deleteMany).not.toHaveBeenCalled();
      expect(prisma.validationResult.createMany).not.toHaveBeenCalled();
    });

    it('rejects a target status this correction can never legally produce', async () => {
      await expect(
        stateMachine.reviewCorrection({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          expectedReviewVersion: 0,
          correctedData: { invoiceNumber: 'RE-2026-001' },
          findings: [],
          to: InvoiceStatus.READY as never,
        }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('rejectGeneration', () => {
    it('replaces only the mapping-prefixed findings, leaving validation findings intact', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.validationResult.deleteMany.mockResolvedValue({ count: 0 });
      prisma.validationResult.createMany.mockResolvedValue({ count: 1 });

      await expect(
        stateMachine.rejectGeneration({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          findings: [
            {
              rule: 'mapping.line_unit',
              field: 'lineItems[0].unit',
              severity: 'ERROR',
              passed: false,
              message: 'Line item unit has no known XRechnung unit code.',
            },
          ],
        }),
      ).resolves.toBe('claimed');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: InvoiceStatus.GENERATING_DOCUMENT,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: { status: InvoiceStatus.NEEDS_REVIEW },
      });
      expect(prisma.validationResult.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: 'invoice-1', rule: { startsWith: 'mapping.' } },
      });
      expect(prisma.validationResult.createMany).toHaveBeenCalledWith({
        data: [
          {
            invoiceId: 'invoice-1',
            rule: 'mapping.line_unit',
            field: 'lineItems[0].unit',
            severity: 'ERROR',
            passed: false,
            message: 'Line item unit has no known XRechnung unit code.',
          },
        ],
      });
    });

    it('does not write findings when the generation lifecycle is stale or expired', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        stateMachine.rejectGeneration({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          findings: [
            {
              rule: 'mapping.line_unit',
              field: 'lineItems[0].unit',
              severity: 'ERROR',
              passed: false,
              message: 'Line item unit has no known XRechnung unit code.',
            },
          ],
        }),
      ).resolves.toBe('lost');

      expect(prisma.validationResult.deleteMany).not.toHaveBeenCalled();
      expect(prisma.validationResult.createMany).not.toHaveBeenCalled();
    });

    it('called twice in a row leaves exactly one mapping-prefixed row set, never touching other findings', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      let rows: { invoiceId: string; rule: string }[] = [
        { invoiceId: 'invoice-1', rule: 'mandatory.party_street' },
      ];
      prisma.validationResult.deleteMany.mockImplementation(
        (args: {
          where: { invoiceId: string; rule?: { startsWith: string } };
        }) => {
          const prefix = args.where.rule?.startsWith;
          const before = rows.length;
          rows = rows.filter(
            (row) =>
              !(
                row.invoiceId === args.where.invoiceId &&
                (prefix === undefined || row.rule.startsWith(prefix))
              ),
          );
          return Promise.resolve({ count: before - rows.length });
        },
      );
      prisma.validationResult.createMany.mockImplementation(
        (args: { data: { invoiceId: string; rule: string }[] }) => {
          rows.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        },
      );

      const findings = [
        {
          rule: 'mapping.line_unit',
          field: 'lineItems[0].unit',
          severity: 'ERROR' as const,
          passed: false,
          message: 'Line item unit has no known XRechnung unit code.',
        },
      ];

      await stateMachine.rejectGeneration({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        findings,
      });
      await stateMachine.rejectGeneration({
        invoiceId: 'invoice-1',
        storageKey: 'storage-key-1',
        findings,
      });

      expect(
        rows
          .filter((row) => row.rule.startsWith('mapping.'))
          .map((row) => row.rule),
      ).toEqual(['mapping.line_unit']);
      expect(rows.map((row) => row.rule)).toContain('mandatory.party_street');
      expect(prisma.validationResult.deleteMany).toHaveBeenCalledTimes(2);
      const expectedDeleteManyCall = {
        where: { invoiceId: 'invoice-1', rule: { startsWith: 'mapping.' } },
      };
      expect(prisma.validationResult.deleteMany).toHaveBeenNthCalledWith(
        1,
        expectedDeleteManyCall,
      );
      expect(prisma.validationResult.deleteMany).toHaveBeenNthCalledWith(
        2,
        expectedDeleteManyCall,
      );
    });
  });

  describe('completeGeneration', () => {
    it('persists the generated document with the final status atomically', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.generatedDocument.create.mockResolvedValue({ id: 'doc-1' });

      await expect(
        stateMachine.completeGeneration({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          to: InvoiceStatus.READY,
          document: {
            format: 'XRECHNUNG_UBL',
            xml: '<Invoice/>',
            isValid: true,
            kositReport: { xml: '<rep:report valid="true"/>' },
          },
          findings: [],
        }),
      ).resolves.toBe('claimed');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: InvoiceStatus.GENERATING_DOCUMENT,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: { status: InvoiceStatus.READY },
      });
      expect(prisma.generatedDocument.create).toHaveBeenCalledWith({
        data: {
          invoiceId: 'invoice-1',
          format: 'XRECHNUNG_UBL',
          xml: '<Invoice/>',
          isValid: true,
          kositReport: { xml: '<rep:report valid="true"/>' },
        },
      });
    });

    it('does not write a document when the generation lifecycle is stale or expired', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        stateMachine.completeGeneration({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          to: InvoiceStatus.READY,
          document: {
            format: 'XRECHNUNG_UBL',
            xml: '<Invoice/>',
            isValid: true,
            kositReport: { xml: '<rep:report valid="false"/>' },
          },
          findings: [],
        }),
      ).resolves.toBe('lost');

      expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
    });
  });

  describe('reopenAfterDeadLetter', () => {
    it('reopens only the lifecycle stored in the dead letter', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        stateMachine.reopenAfterDeadLetter({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          to: InvoiceStatus.EXTRACTING_TEXT,
        }),
      ).resolves.toBe('claimed');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'invoice-1',
          storageKey: 'storage-key-1',
          status: InvoiceStatus.FAILED,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: {
          status: InvoiceStatus.EXTRACTING_TEXT,
          failureCode: null,
          failureParams: Prisma.DbNull,
        },
      });
    });

    it('is retryable after the row was reopened but the queue add failed', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoice.findFirst.mockResolvedValue({ id: 'invoice-1' });

      await expect(
        stateMachine.reopenAfterDeadLetter({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          to: InvoiceStatus.EXTRACTING_TEXT,
        }),
      ).resolves.toBe('claimed');
    });

    it('rejects a dead letter from an expired lifecycle', async () => {
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoice.findFirst.mockResolvedValue(null);

      await expect(
        stateMachine.reopenAfterDeadLetter({
          invoiceId: 'invoice-1',
          storageKey: 'old-storage-key',
          to: InvoiceStatus.EXTRACTING_TEXT,
        }),
      ).resolves.toBe('lost');
    });

    it('rejects a reopen target no stage config names, before touching the database', async () => {
      await expect(
        stateMachine.reopenAfterDeadLetter({
          invoiceId: 'invoice-1',
          storageKey: 'storage-key-1',
          to: InvoiceStatus.READY,
        }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });
  });
});
