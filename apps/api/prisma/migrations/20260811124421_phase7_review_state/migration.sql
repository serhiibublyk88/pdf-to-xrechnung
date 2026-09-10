BEGIN;

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'GENERATING_DOCUMENT';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "reviewedData" JSONB;

-- CreateIndex
CREATE INDEX "Invoice_ownerId_createdAt_idx" ON "Invoice"("ownerId", "createdAt");

COMMIT;
