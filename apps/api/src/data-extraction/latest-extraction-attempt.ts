import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export const LATEST_PARSED_ATTEMPT_RULE = {
  where: { parsedData: { not: Prisma.DbNull } },
  orderBy: { attemptNumber: 'desc' },
} satisfies {
  where: Prisma.ExtractionAttemptWhereInput;
  orderBy: Prisma.ExtractionAttemptOrderByWithRelationInput;
};

export async function latestParsedExtractionAttempt(
  prisma: PrismaService,
  invoiceId: string,
  storageKey: string,
): Promise<Prisma.JsonValue | undefined> {
  const attempt = await prisma.extractionAttempt.findFirst({
    where: { invoiceId, storageKey, ...LATEST_PARSED_ATTEMPT_RULE.where },
    orderBy: LATEST_PARSED_ATTEMPT_RULE.orderBy,
    select: { parsedData: true },
  });
  return attempt?.parsedData;
}
