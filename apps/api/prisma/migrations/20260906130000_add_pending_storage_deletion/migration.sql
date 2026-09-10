CREATE TABLE "PendingStorageDeletion" (
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingStorageDeletion_pkey" PRIMARY KEY ("storageKey")
);
