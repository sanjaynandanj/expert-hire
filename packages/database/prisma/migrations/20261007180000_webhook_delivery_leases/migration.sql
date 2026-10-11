ALTER TABLE "WebhookDelivery" ADD COLUMN "processingToken" TEXT, ADD COLUMN "processingExpiresAt" TIMESTAMP(3);
CREATE INDEX "WebhookDelivery_status_processingExpiresAt_idx" ON "WebhookDelivery"("status", "processingExpiresAt");
