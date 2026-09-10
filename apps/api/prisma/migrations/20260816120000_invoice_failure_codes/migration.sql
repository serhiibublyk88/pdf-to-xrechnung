ALTER TABLE "Invoice"
DROP COLUMN "failureReason",
ADD COLUMN "failureCode" TEXT,
ADD COLUMN "failureParams" JSONB;
