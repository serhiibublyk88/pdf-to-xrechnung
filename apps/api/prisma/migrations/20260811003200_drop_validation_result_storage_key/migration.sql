BEGIN;

DROP INDEX "ValidationResult_invoiceId_storageKey_passed_idx";

ALTER TABLE "ValidationResult" DROP COLUMN "storageKey";

COMMIT;
