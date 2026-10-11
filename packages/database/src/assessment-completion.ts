import type { Prisma } from "../generated/client/client";
import { persistWebhookEvent } from "./webhook-outbox";

type Evaluation = { overallScore: number; summary: string; evidence: Array<{ name: string; score: number; weight: number; rationale: string; evidence: string }> };

/** Serializes completion so retried/stalled evaluation jobs cannot duplicate evidence or events. */
export async function completeAssessment(tx: Prisma.TransactionClient, id: string, result: Evaluation, owner?: { token: string; now?: Date }) {
  await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id" = ${id} FOR UPDATE`;
  const current = await tx.assessment.findUniqueOrThrow({ where: { id }, select: { status: true, processingMode: true, evaluationToken: true, evaluationExpiresAt: true, candidateId: true, candidate: { select: { organizationId: true } } } });
  if (current.status === "COMPLETED") return { assessment: await tx.assessment.findUniqueOrThrow({ where: { id }, include: { evidence: true } }), deliveries: [] as string[], replayed: true };
  if (current.status !== "PROCESSING") throw new Error(`Assessment cannot be completed from ${current.status}`);
  if ((current.processingMode === "QUEUE" && !owner) || (owner && (current.evaluationToken !== owner.token || !current.evaluationExpiresAt || current.evaluationExpiresAt <= (owner.now ?? new Date())))) throw new Error("Assessment evaluation lease is no longer owned by this worker.");
  const assessment = await tx.assessment.update({ where: { id }, data: {
    status: "COMPLETED", score: result.overallScore, summary: result.summary,
    completedAt: new Date(), launchTokenHash: null, evaluationToken: null, evaluationExpiresAt: null,
    evidence: { create: result.evidence.map((item) => ({ criterion: item.name, score: item.score, weight: item.weight, rationale: item.rationale, evidence: item.evidence })) }
  }, include: { evidence: true } });
  await tx.auditEvent.create({ data: { organizationId: current.candidate.organizationId, action: "assessment.completed", entityType: "assessment", entityId: id, metadata: { advisoryOnly: true, score: result.overallScore } } });
  const deliveries = await persistWebhookEvent(tx, current.candidate.organizationId, "assessment.completed", { assessment_id: id, candidate_id: current.candidateId, score: result.overallScore });
  return { assessment, deliveries, replayed: false };
}
