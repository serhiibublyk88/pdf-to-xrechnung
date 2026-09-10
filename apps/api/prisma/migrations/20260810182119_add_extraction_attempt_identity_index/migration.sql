-- CreateIndex
CREATE INDEX "ExtractionAttempt_invoiceId_provider_model_promptVersion_idx" ON "ExtractionAttempt"("invoiceId", "provider", "model", "promptVersion");
