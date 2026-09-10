BEGIN;

ALTER TABLE "ValidationResult" ADD COLUMN "storageKey" TEXT;

UPDATE "ValidationResult" AS "validation"
SET "storageKey" = "invoice"."storageKey"
FROM "Invoice" AS "invoice"
WHERE "validation"."invoiceId" = "invoice"."id";

ALTER TABLE "ValidationResult" ALTER COLUMN "storageKey" SET NOT NULL;

DROP INDEX "ValidationResult_invoiceId_passed_idx";

CREATE INDEX "ValidationResult_invoiceId_storageKey_passed_idx"
ON "ValidationResult"("invoiceId", "storageKey", "passed");

COMMIT;
