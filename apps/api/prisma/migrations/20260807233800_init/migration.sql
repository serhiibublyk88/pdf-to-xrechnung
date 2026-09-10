BEGIN;

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UPLOADED', 'EXTRACTING_TEXT', 'TEXT_READY', 'EXTRACTING_DATA', 'DATA_READY', 'VALIDATING', 'NEEDS_REVIEW', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('NATIVE', 'OCR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('ERROR', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "DocumentFormat" AS ENUM ('XRECHNUNG_UBL', 'XRECHNUNG_CII', 'ZUGFERD');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UPLOADED',
    "sourceType" "SourceType" NOT NULL DEFAULT 'UNKNOWN',
    "fileHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "extractedText" TEXT,
    "textCharCount" INTEGER,
    "failureReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionAttempt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "parsedData" JSONB,
    "confidence" JSONB,
    "parseError" TEXT,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationResult" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "field" TEXT,
    "severity" "Severity" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "expected" TEXT,
    "actual" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "format" "DocumentFormat" NOT NULL,
    "xml" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL,
    "kositReport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_storageKey_key" ON "Invoice"("storageKey");

-- CreateIndex
CREATE INDEX "Invoice_ownerId_idx" ON "Invoice"("ownerId");

-- CreateIndex
CREATE INDEX "Invoice_fileHash_idx" ON "Invoice"("fileHash");

-- CreateIndex
CREATE INDEX "Invoice_expiresAt_idx" ON "Invoice"("expiresAt");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "ExtractionAttempt_invoiceId_idx" ON "ExtractionAttempt"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionAttempt_invoiceId_attemptNumber_key" ON "ExtractionAttempt"("invoiceId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ValidationResult_invoiceId_idx" ON "ValidationResult"("invoiceId");

-- CreateIndex
CREATE INDEX "ValidationResult_invoiceId_passed_idx" ON "ValidationResult"("invoiceId", "passed");

-- CreateIndex
CREATE INDEX "GeneratedDocument_invoiceId_idx" ON "GeneratedDocument"("invoiceId");

-- AddForeignKey
ALTER TABLE "ExtractionAttempt" ADD CONSTRAINT "ExtractionAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
