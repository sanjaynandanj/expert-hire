ALTER TABLE "Assessment" ADD COLUMN "evaluationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "evaluationToken" TEXT,
ADD COLUMN "evaluationExpiresAt" TIMESTAMP(3);
CREATE INDEX "Assessment_processing_recovery_idx" ON "Assessment" ("status", "processingMode", "evaluationExpiresAt");
