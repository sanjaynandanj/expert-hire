import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgresql://northstar:northstar@localhost:5432/northstar?schema=public";
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "../generated/client/client";
export { persistWebhookEvent } from "./webhook-outbox";
export { completeAssessment } from "./assessment-completion";
export { claimAssessmentEvaluation, releaseAssessmentEvaluation, recoverAssessmentEvaluations, assessmentAttemptLimit, assessmentLeaseMs } from "./assessment-processing";
export { snapshotAssessmentConfiguration, resolveAssessmentConfiguration, type AssessmentConfiguration } from "./assessment-configuration";
export { claimWebhookDelivery, finishWebhookDelivery, recoverWebhookDeliveries, webhookAttemptLimit, webhookLeaseMs } from "./webhook-delivery";
