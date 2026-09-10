-- CreateIndex
CREATE UNIQUE INDEX "Invoice_ownerId_fileHash_key" ON "Invoice"("ownerId", "fileHash");
