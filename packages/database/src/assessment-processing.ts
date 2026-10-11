import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/client/client";

export const assessmentAttemptLimit = 3;
export const assessmentLeaseMs = 60_000;

/** Database ownership and retry budgets survive Redis loss and worker restarts. */
export async function claimAssessmentEvaluation(tx: Prisma.TransactionClient, id: string, now = new Date()) {
  const token = randomUUID();
  const claimed = await tx.assessment.updateMany({ where: {
    id, status: "PROCESSING", processingMode: "QUEUE", submittedResponse: { not: null },
    evaluationAttempts: { lt: assessmentAttemptLimit },
    OR: [{ evaluationExpiresAt: null }, { evaluationExpiresAt: { lte: now } }]
  }, data: { evaluationToken: token, evaluationExpiresAt: new Date(now.getTime() + assessmentLeaseMs), evaluationAttempts: { increment: 1 } } });
  if (!claimed.count) return null;
  const assessment = await tx.assessment.findUniqueOrThrow({ where: { id }, include: { candidate: true, round: { include: { job: { include: { requirements: true } } } } } });
  return { assessment, token };
}

export async function releaseAssessmentEvaluation(tx: Prisma.TransactionClient, id: string, token: string, terminal = false, now = new Date()) {
  const current = await tx.assessment.findUnique({ where: { id }, select: { evaluationAttempts: true } });
  if (!current) return false;
  const failed = terminal || current.evaluationAttempts >= assessmentAttemptLimit;
  const saved = await tx.assessment.updateMany({ where: { id, status: "PROCESSING", evaluationToken: token, evaluationExpiresAt: { gt: now } },
    data: { ...(failed ? { status: "FAILED", launchTokenHash: null } : {}), evaluationToken: null, evaluationExpiresAt: null } });
  return saved.count === 1;
}

export async function recoverAssessmentEvaluations(tx: Prisma.TransactionClient, now = new Date(), candidateId?: string) {
  const exhausted = await tx.assessment.updateMany({ where: {
    ...(candidateId ? { candidateId } : {}), status: "PROCESSING", processingMode: "QUEUE", evaluationAttempts: { gte: assessmentAttemptLimit },
    OR: [{ evaluationExpiresAt: null }, { evaluationExpiresAt: { lte: now } }]
  }, data: { status: "FAILED", launchTokenHash: null, evaluationToken: null, evaluationExpiresAt: null } });
  return { exhausted: exhausted.count };
}
