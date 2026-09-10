import { Invoice, InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

export async function waitForStatus(
  prisma: PrismaService,
  invoiceId: string,
  predicate: InvoiceStatus | ((status: InvoiceStatus) => boolean),
  timeoutMs: number,
): Promise<Invoice> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    if (
      typeof predicate === 'function'
        ? predicate(invoice.status)
        : invoice.status === predicate
    ) {
      return invoice;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Invoice ${invoiceId} did not reach the expected status within ${timeoutMs}ms (currently ${invoice.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
