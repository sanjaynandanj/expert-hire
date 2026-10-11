CREATE TABLE "NovaRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "message" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}',
  "response" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "processingToken" TEXT,
  "processingExpiresAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "NovaRun_organizationId_userId_createdAt_idx" ON "NovaRun" ("organizationId", "userId", "createdAt");
CREATE INDEX "NovaRun_status_processingExpiresAt_idx" ON "NovaRun" ("status", "processingExpiresAt");
CREATE TABLE "NovaToolCall" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL REFERENCES "NovaRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "arguments" JSONB NOT NULL,
  "result" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE INDEX "NovaToolCall_runId_createdAt_idx" ON "NovaToolCall" ("runId", "createdAt");
CREATE TABLE "NovaProposal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL REFERENCES "NovaRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "actions" JSONB NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "contextHash" TEXT NOT NULL,
  "totalCredits" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "executedAt" TIMESTAMP(3),
  "resultEncrypted" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "NovaProposal_runId_status_idx" ON "NovaProposal" ("runId", "status");
