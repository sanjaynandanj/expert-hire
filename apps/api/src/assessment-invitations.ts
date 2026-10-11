import { Prisma, snapshotAssessmentConfiguration } from "@northstar/database";
import { applyCreditMovement, creditCosts, hasPermission, type AssessmentType, type Role } from "@northstar/domain";
import { createHash, randomBytes } from "node:crypto";

export type InvitationInput = { candidateId: string; roundId: string; expiresInHours: number };
export type InvitationActor = { organizationId: string; userId: string };
export function requestError(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Shared transaction boundary for browser and agent invitations. Never call from a model directly. */
export async function createAssessmentInvitation(tx: Prisma.TransactionClient, actor: InvitationActor, input: InvitationInput, idempotencyKey: string) {
  await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "userId" = ${actor.userId} AND "organizationId" = ${actor.organizationId} FOR SHARE`;
  const membership = await tx.membership.findUnique({ where: { userId_organizationId: { userId: actor.userId, organizationId: actor.organizationId } } });
  if (!membership || !hasPermission(membership.role as Role, "candidate.manage")) throw requestError("permission_denied", "You cannot create assessment invitations in this workspace.", 403);
  if (process.env.NODE_ENV === "production") throw requestError("assessment_provider_unavailable", "Assessment invitations are disabled until a reviewed production provider is configured.", 503);
  const requestHash = digest(JSON.stringify([input.candidateId, input.roundId, input.expiresInHours]));
  async function replay() {
    const ledger = await tx.creditLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey } } });
    if (!ledger) return null;
    if (ledger.referenceType !== "assessment" || !ledger.referenceId || ledger.requestHash && ledger.requestHash !== requestHash) throw requestError("idempotency_key_conflict", "This idempotency key was already used for a different request.");
    const assessment = await tx.assessment.findFirst({ where: { id: ledger.referenceId, candidate: { organizationId: actor.organizationId } } });
    if (!assessment || assessment.candidateId !== input.candidateId || assessment.roundId !== input.roundId) throw requestError("idempotency_key_conflict", "This key's original assessment is unavailable or differs from this request.");
    return { assessment, launchUrl: null, replayed: true };
  }
  const existing = await replay();
  if (existing) return existing;
  const candidate = await tx.candidate.findFirst({ where: { id: input.candidateId, organizationId: actor.organizationId }, select: { id: true } });
  const round = await tx.round.findFirst({ where: { id: input.roundId, job: { organizationId: actor.organizationId } }, select: { id: true, jobId: true } });
  if (!candidate || !round) throw requestError("assessment_target_not_found", "Candidate or round was not found in this organization.", 404);
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${round.jobId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Round" WHERE "id" = ${round.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${actor.organizationId} FOR NO KEY UPDATE`;
  const raced = await replay();
  if (raced) return raced;
  const currentRound = await tx.round.findFirst({ where: { id: round.id, job: { organizationId: actor.organizationId } }, include: { job: { include: { requirements: { orderBy: { sortOrder: "asc" } } } } } });
  if (!currentRound) throw requestError("assessment_target_not_found", "This assessment round is no longer available.", 404);
  if (currentRound.retiredAt) throw requestError("assessment_round_retired", "This round is retired and no longer accepts new invitations.");
  if (currentRound.type === "CODING_TEST") throw requestError("code_sandbox_unavailable", "Coding assessments cannot be invited until an isolated execution provider is configured.", 503);
  const cost = creditCosts[currentRound.type as AssessmentType];
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { creditBalance: true } });
  if (organization.creditBalance < cost) throw requestError("insufficient_credits", "This workspace does not have enough credits for the selected assessment round.");
  const balanceAfter = applyCreditMovement(organization.creditBalance, -cost);
  const rawToken = randomBytes(32).toString("base64url");
  const assessment = await tx.assessment.create({ data: { candidateId: candidate.id, roundId: round.id, status: "PENDING", configuration: snapshotAssessmentConfiguration(currentRound) as unknown as Prisma.InputJsonValue, launchTokenHash: digest(rawToken), launchExpiresAt: new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000) } });
  await tx.organization.update({ where: { id: actor.organizationId }, data: { creditBalance: balanceAfter } });
  await tx.creditLedger.create({ data: { organizationId: actor.organizationId, amount: -cost, balanceAfter, reason: `Assessment created: ${currentRound.type}`, idempotencyKey, requestHash, referenceType: "assessment", referenceId: assessment.id } });
  await tx.auditEvent.create({ data: { organizationId: actor.organizationId, actorId: actor.userId, action: "assessment.created", entityType: "assessment", entityId: assessment.id, metadata: { type: currentRound.type, creditCost: cost } } });
  return { assessment, launchUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/assess/${rawToken}`, replayed: false };
}
