ALTER TABLE "NovaRun" ADD COLUMN "transcript" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "modelSteps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "provider" TEXT,
ADD COLUMN "model" TEXT;
ALTER TABLE "NovaToolCall" ADD COLUMN "modelCallId" TEXT;
CREATE UNIQUE INDEX "NovaToolCall_runId_modelCallId_key" ON "NovaToolCall" ("runId", "modelCallId");
