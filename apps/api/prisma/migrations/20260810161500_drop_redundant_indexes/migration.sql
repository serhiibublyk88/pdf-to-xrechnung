BEGIN;

-- DropIndex
-- Invoice_fileHash_idx: no query filters by fileHash alone (dedup is always
-- (ownerId, fileHash), already covered by the unique constraint).
DROP INDEX "Invoice_fileHash_idx";

-- DropIndex
-- ExtractionAttempt_invoiceId_idx: covered by the leading column of
-- ExtractionAttempt_invoiceId_attemptNumber_key.
DROP INDEX "ExtractionAttempt_invoiceId_idx";

-- DropIndex
-- ValidationResult_invoiceId_idx: covered by the leading column of
-- ValidationResult_invoiceId_passed_idx.
DROP INDEX "ValidationResult_invoiceId_idx";

COMMIT;
