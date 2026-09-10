import { z } from 'zod';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';

export const GoldenFixtureSchema = z
  .object({
    meta: z
      .object({
        id: z.string().regex(/^\d{3}-[a-z0-9-]+$/),
        language: z.enum(['de', 'en']),
        sourceType: z.enum(['native', 'ocr']),
        content: z.enum(['invoice', 'not-an-invoice']),
        scanQuality: z
          .enum(['clean', 'degraded', 'blank', 'illegible'])
          .optional(),
        pages: z.number().int().positive(),
        expectedOutcome: z.enum(['success', 'needs_review', 'failed']),
        expectedErrors: z.array(z.string()),
        notes: z.string().min(1),
      })
      .strict(),
    data: RawExtractedInvoiceDataSchema,
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      fixture.meta.sourceType === 'ocr' &&
      fixture.meta.scanQuality === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'scanQuality'],
        message: 'OCR fixtures must declare scanQuality',
      });
    }
    if (
      fixture.meta.sourceType === 'native' &&
      fixture.meta.scanQuality !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'scanQuality'],
        message: 'Only OCR fixtures may declare scanQuality',
      });
    }
  });

export type GoldenFixture = z.infer<typeof GoldenFixtureSchema>;
export type { Party } from '@pdf-to-xrechnung/contracts';
