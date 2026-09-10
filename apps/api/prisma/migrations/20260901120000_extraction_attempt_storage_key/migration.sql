BEGIN;

ALTER TABLE "ExtractionAttempt" ADD COLUMN "storageKey" TEXT;

UPDATE "ExtractionAttempt" AS "attempt"
SET "storageKey" = "invoice"."storageKey"
FROM "Invoice" AS "invoice"
WHERE "attempt"."invoiceId" = "invoice"."id";

ALTER TABLE "ExtractionAttempt" ALTER COLUMN "storageKey" SET NOT NULL;

DROP INDEX "ExtractionAttempt_invoiceId_attemptNumber_key";
DROP INDEX "ExtractionAttempt_invoiceId_provider_model_promptVersion_idx";

CREATE UNIQUE INDEX "ExtractionAttempt_invoiceId_storageKey_attemptNumber_key"
ON "ExtractionAttempt"("invoiceId", "storageKey", "attemptNumber");

CREATE INDEX "ExtractionAttempt_invoiceId_storageKey_provider_model_promp_idx"
ON "ExtractionAttempt"("invoiceId", "storageKey", "provider", "model", "promptVersion");

COMMIT;
