import { InvoiceStatus, Prisma } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import type { PipelineStage } from './pipeline-stage';

const BATCH_SIZE = 100;

export interface StrandedInvoice {
  id: string;
  storageKey: string;
  status: InvoiceStatus;
}

async function requeueStrandedInvoices({
  prisma,
  where,
  requeue,
}: {
  prisma: PrismaService;
  where: Prisma.InvoiceWhereInput;
  requeue: (invoice: StrandedInvoice) => Promise<boolean>;
}): Promise<number> {
  let lastSeenId: string | undefined;
  let requeued = 0;

  for (;;) {
    const stranded = await prisma.invoice.findMany({
      where: {
        AND: [
          where,
          { expiresAt: { gt: new Date() } },
          ...(lastSeenId ? [{ id: { gt: lastSeenId } }] : []),
        ],
      },
      select: { id: true, storageKey: true, status: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    });
    if (stranded.length === 0) {
      break;
    }

    for (const invoice of stranded) {
      if (await requeue(invoice)) {
        requeued++;
      }
    }

    const last = stranded.at(-1);
    if (!last || stranded.length < BATCH_SIZE) {
      break;
    }
    lastSeenId = last.id;
  }

  return requeued;
}

export async function reconcileStage({
  prisma,
  queue,
  stage,
  logger,
  where,
  requeue,
}: {
  prisma: PrismaService;
  queue: { reconcileFailedJobs(): Promise<number> };
  stage: PipelineStage;
  logger: PinoLogger;
  where: Prisma.InvoiceWhereInput;
  requeue: (invoice: StrandedInvoice) => Promise<boolean>;
}): Promise<void> {
  const recoveredFailures = await queue.reconcileFailedJobs();
  const requeued = await requeueStrandedInvoices({ prisma, where, requeue });

  if (requeued > 0) {
    logger.info({ stage, requeued }, 'Reconciled stranded jobs on startup');
  }
  if (recoveredFailures > 0) {
    logger.info(
      { stage, recovered: recoveredFailures },
      'Recovered exhausted jobs on startup',
    );
  }
}
