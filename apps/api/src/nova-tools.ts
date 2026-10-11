import { prisma, Prisma, resolveAssessmentConfiguration } from "@northstar/database";
import { creditCosts, hasPermission, type Permission, type Role } from "@northstar/domain";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { z } from "zod";
import { createAssessmentInvitation, requestError, type InvitationActor } from "./assessment-invitations";

export type NovaActor = InvitationActor & { sessionId?: string };
export const novaSelectionSchema = z.object({ jobId: z.string().min(1), selectedAssessmentIds: z.array(z.string().min(1)).max(10).default([]), nextRoundId: z.string().min(1).optional() }).strict();
export const novaToolSchemas = {
  list_roles: z.object({}).strict(),
  list_completed_assessments: z.object({ jobId: z.string().min(1), afterId: z.string().min(1).optional() }).strict(),
  read_assessment_report: z.object({ assessmentId: z.string().min(1) }).strict(),
  prepare_invitations: z.object({ assessmentIds: z.array(z.string().min(1)).min(1).max(10), roundId: z.string().min(1), expiresInHours: z.number().int().min(1).max(168).default(72) }).strict()
};
export type NovaToolName = keyof typeof novaToolSchemas;
const actionsSchema = z.array(z.object({ sourceAssessmentId: z.string(), candidateId: z.string(), candidateName: z.string(), candidateEmail: z.string(), roundId: z.string(), roundTitle: z.string(), jobId: z.string(), jobTitle: z.string(), expiresInHours: z.number().int().min(1).max(168), credits: z.number().int().positive() }).strict()).min(1).max(10);
export const novaHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function authorizeNova(tx: Prisma.TransactionClient, actor: NovaActor, permission: Permission) {
  // Hold authorization stable for the transaction, matching invitation approval's lock order.
  await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "userId" = ${actor.userId} AND "organizationId" = ${actor.organizationId} FOR SHARE`;
  if (actor.sessionId) await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${actor.sessionId} AND "userId" = ${actor.userId} FOR SHARE`;
  if (actor.sessionId && !await tx.session.findFirst({ where: { id: actor.sessionId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } })) throw requestError("session_required", "Sign in again to use Nova.", 401);
  const membership = await tx.membership.findUnique({ where: { userId_organizationId: { userId: actor.userId, organizationId: actor.organizationId } } });
  if (!membership || !hasPermission(membership.role as Role, permission)) throw requestError("permission_denied", "This Nova action is not allowed in your workspace.", 403);
}

async function ownedRun(tx: Prisma.TransactionClient, actor: NovaActor, runId: string) {
  await authorizeNova(tx, actor, "report.read");
  const run = await tx.novaRun.findFirst({ where: { id: runId, organizationId: actor.organizationId, userId: actor.userId } });
  if (!run) throw requestError("nova_run_not_found", "Nova run was not found.", 404);
  if (run.cancelledAt || run.status === "CANCELLED") throw requestError("nova_cancelled", "This Nova run has been cancelled.");
  return run;
}

/** Same bounded typed tools are used by the runtime; no arbitrary API/SQL tool exists. */
export async function callNovaTool(actor: NovaActor, runId: string, name: NovaToolName, input: unknown, owner?: { token: string; callId: string }) {
  if (!Object.hasOwn(novaToolSchemas, name)) throw requestError("nova_tool_unavailable", "This tool is not available to Nova.", 403);
  const parsed = novaToolSchemas[name].safeParse(input);
  if (!parsed.success) throw requestError("nova_tool_arguments_invalid", "Nova tool arguments are invalid.", 422);
  async function checkOwner(tx: Prisma.TransactionClient) {
    if (!owner) return;
    await tx.$queryRaw`SELECT "id" FROM "NovaRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await ownedRun(tx, actor, runId);
    if (run.status !== "RUNNING" || run.processingToken !== owner.token || !run.processingExpiresAt || run.processingExpiresAt <= new Date()) throw requestError("nova_stale_owner", "This agent run is no longer owned by this processor.");
  }
  const permission: Permission = name === "list_roles" ? "job.read" : name === "prepare_invitations" ? "candidate.manage" : "candidate.read";
  const call = await prisma.$transaction(async (tx) => {
    await checkOwner(tx);
    const run = await ownedRun(tx, actor, runId);
    await authorizeNova(tx, actor, permission);
    if (!["PENDING", "RUNNING"].includes(run.status)) throw requestError("nova_run_closed", "This run is not accepting tool calls.");
    if (owner) {
      const previous = await tx.novaToolCall.findUnique({ where: { runId_modelCallId: { runId, modelCallId: owner.callId } } });
      if (previous) {
        // PostgreSQL JSONB reorders object keys. Reparse through the same typed
        // schema before comparing, so unchanged multi-field calls survive replay.
        const stored = novaToolSchemas[name].safeParse(previous.arguments);
        if (previous.name !== name || !stored.success || novaHash(stored.data) !== novaHash(parsed.data)) throw requestError("nova_call_mismatch", "The stored tool call differs from this request.");
        return previous;
      }
    }
    return tx.novaToolCall.create({ data: { runId, name, arguments: json(parsed.data), modelCallId: owner?.callId ?? null } });
  });
  if (call.status === "COMPLETED") return call.result;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await checkOwner(tx);
      const run = await ownedRun(tx, actor, runId);
      await authorizeNova(tx, actor, permission);
      async function completed(value: unknown) {
        await tx.novaToolCall.update({ where: { id: call.id }, data: { status: "COMPLETED", result: json(value), completedAt: new Date() } });
        return value;
      }
      if (name === "list_roles") {
        await authorizeNova(tx, actor, "job.read");
        return completed({ roles: await tx.job.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, title: true, status: true }, orderBy: { id: "asc" }, take: 100 }), limit: 100 });
      }
      if (name === "list_completed_assessments") {
        await authorizeNova(tx, actor, "candidate.read");
        const args = novaToolSchemas.list_completed_assessments.parse(input);
        const job = await tx.job.findFirst({ where: { id: args.jobId, organizationId: actor.organizationId }, select: { id: true } });
        if (!job) throw requestError("nova_target_not_found", "Role was not found in this workspace.", 404);
        const rows = await tx.assessment.findMany({ where: { status: "COMPLETED", candidate: { organizationId: actor.organizationId }, round: { jobId: args.jobId }, ...(args.afterId ? { id: { gt: args.afterId } } : {}) },
          select: { id: true, candidateId: true, candidate: { select: { name: true } }, round: { select: { id: true, title: true, sequence: true } } }, orderBy: { id: "asc" }, take: 21 });
        return completed({ assessments: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19]!.id : null, orderedBy: "id_not_score" });
      }
      if (name === "read_assessment_report") {
        await authorizeNova(tx, actor, "candidate.read");
        const args = novaToolSchemas.read_assessment_report.parse(input);
        const assessment = await tx.assessment.findFirst({ where: { id: args.assessmentId, status: "COMPLETED", candidate: { organizationId: actor.organizationId }, round: { job: { organizationId: actor.organizationId } } },
          include: { evidence: { orderBy: { id: "asc" } }, round: { include: { job: { include: { requirements: { orderBy: { sortOrder: "asc" } } } } } } } });
        if (!assessment) throw requestError("nova_target_not_found", "Completed assessment was not found in this workspace.", 404);
        const context = run.context as { jobId?: string };
        if (context.jobId && context.jobId !== assessment.round.jobId) throw requestError("nova_target_not_found", "This assessment is not for the selected role.", 404);
        const configuration = resolveAssessmentConfiguration(assessment);
        // No contact details, launch tokens or unrestricted candidate submission blobs go to the model.
        return completed({ assessmentId: assessment.id, reportPath: `/workspace/reports/${assessment.id}`, jobId: assessment.round.jobId, jobTitle: configuration.job.title,
          rubric: configuration.job.requirements, evidence: assessment.evidence.map((item) => ({ id: item.id, criterion: item.criterion, weight: item.weight, evidence: item.evidence.slice(0, 4000), rationale: item.rationale.slice(0, 2000) })), advisoryOnly: true, untrustedCandidateContent: true });
      }
      await authorizeNova(tx, actor, "candidate.manage");
      const args = novaToolSchemas.prepare_invitations.parse(input);
      const selection = novaSelectionSchema.parse(run.context);
      const supplied = [...new Set(args.assessmentIds)].sort();
      if (supplied.length !== args.assessmentIds.length || JSON.stringify(supplied) !== JSON.stringify([...new Set(selection.selectedAssessmentIds)].sort()) || args.roundId !== selection.nextRoundId) throw requestError("nova_selection_required", "Nova may only prepare the exact candidates and round explicitly selected by the recruiter.", 403);
      if (process.env.NODE_ENV === "production") throw requestError("assessment_provider_unavailable", "Invitations require a reviewed production assessment provider.", 503);
      const context = await invitationContext(tx, actor, selection, args.expiresInHours);
      if (context.balance < context.totalCredits) throw requestError("insufficient_credits", "This workspace does not have enough assessment credits.");
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const contextHash = novaHash(context.version);
      const fingerprint = novaHash({ id, runId, actions: context.actions, contextHash, totalCredits: context.totalCredits, expiresAt: expiresAt.toISOString() });
      // Serialize against cancellation and prevent multiple actionable proposals for one run.
      await tx.$queryRaw`SELECT "id" FROM "NovaRun" WHERE "id" = ${runId} FOR UPDATE`;
      await ownedRun(tx, actor, runId);
      await tx.novaProposal.updateMany({ where: { runId, status: "PROPOSED" }, data: { status: "SUPERSEDED" } });
      const proposal = await tx.novaProposal.create({ data: { id, runId, actions: json(context.actions), fingerprint, contextHash, totalCredits: context.totalCredits, expiresAt } });
      return completed({ proposal: publicProposal(proposal), approvalRequired: true });
    }, { timeout: 10_000 });
    return result;
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("nova_") ? error.code : "nova_tool_failed";
    await prisma.novaToolCall.update({ where: { id: call.id }, data: { status: "FAILED", errorCode: code, completedAt: new Date() } });
    throw error;
  }
}

async function invitationContext(tx: Prisma.TransactionClient, actor: NovaActor, selection: z.infer<typeof novaSelectionSchema>, expiresInHours: number) {
  if (!selection.nextRoundId || !selection.selectedAssessmentIds.length) throw requestError("nova_selection_required", "Select candidates and the next round first.", 422);
  const [job, round, sources, organization] = await Promise.all([
    tx.job.findFirst({ where: { id: selection.jobId, organizationId: actor.organizationId }, include: { requirements: { orderBy: { id: "asc" } } } }),
    tx.round.findFirst({ where: { id: selection.nextRoundId, jobId: selection.jobId, job: { organizationId: actor.organizationId } } }),
    tx.assessment.findMany({ where: { id: { in: selection.selectedAssessmentIds }, status: "COMPLETED", candidate: { organizationId: actor.organizationId }, round: { jobId: selection.jobId } }, include: { candidate: true, evidence: { orderBy: { id: "asc" } }, round: true }, orderBy: { id: "asc" } }),
    tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { creditBalance: true } })
  ]);
  if (!job || !round || sources.length !== selection.selectedAssessmentIds.length) throw requestError("nova_context_stale", "The selected role, round or completed assessments are no longer available.");
  if (round.retiredAt || round.type === "CODING_TEST" || sources.some((source) => source.round.sequence >= round.sequence) || new Set(sources.map((source) => source.candidateId)).size !== sources.length) throw requestError("nova_context_stale", "Choose one completed assessment per candidate and a later, active non-coding round.");
  const existing = await tx.assessment.findMany({ where: { roundId: round.id, candidateId: { in: sources.map((source) => source.candidateId) } }, select: { id: true, status: true }, orderBy: { id: "asc" } });
  if (existing.length) throw requestError("nova_context_stale", "A selected candidate already has an assessment for this round. Review it before preparing another invitation.");
  const actions = sources.map((source) => ({ sourceAssessmentId: source.id, candidateId: source.candidateId, candidateName: source.candidate.name, candidateEmail: source.candidate.email, roundId: round.id, roundTitle: round.title, jobId: job.id, jobTitle: job.title, expiresInHours, credits: creditCosts[round.type] }));
  return { actions, totalCredits: actions.reduce((sum, action) => sum + action.credits, 0), balance: organization.creditBalance,
    version: { job, round, balance: organization.creditBalance, sources: sources.map((source) => ({ id: source.id, status: source.status, updatedAt: source.updatedAt, configuration: source.configuration, candidate: source.candidate, evidence: source.evidence, round: source.round })) } };
}

type Proposal = Awaited<ReturnType<typeof prisma.novaProposal.findUniqueOrThrow>>;
export function publicProposal(proposal: Proposal) {
  return { id: proposal.id, runId: proposal.runId, status: proposal.status, actions: proposal.actions, fingerprint: proposal.fingerprint, totalCredits: proposal.totalCredits, expiresAt: proposal.expiresAt, approvedAt: proposal.approvedAt, executedAt: proposal.executedAt };
}

function resultKey() {
  const secret = process.env.NOVA_RESULT_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) throw requestError("nova_encryption_unavailable", "Configure Nova's result encryption key before executing invitations.", 503);
  return scryptSync(secret ?? "local-development-nova-result-encryption", "northstar-nova-results-v1", 32);
}
function sealResult(proposalId: string, value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resultKey(), iv);
  cipher.setAAD(Buffer.from(proposalId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(":");
}
export function readProposalResult(proposal: Proposal) {
  if (!proposal.resultEncrypted || proposal.status !== "EXECUTED") return null;
  const [iv, tag, data] = proposal.resultEncrypted.split(":");
  if (!iv || !tag || !data) throw requestError("nova_result_unavailable", "The saved invitation result could not be read.", 503);
  const decipher = createDecipheriv("aes-256-gcm", resultKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(proposal.id));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as unknown;
}

/** Human approval and all invitation effects commit together; model tools cannot call this. */
export async function approveNovaProposal(actor: NovaActor, proposalId: string, fingerprint: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "userId" = ${actor.userId} AND "organizationId" = ${actor.organizationId} FOR SHARE`;
    await authorizeNova(tx, actor, "candidate.manage");
    const target = await tx.novaProposal.findFirst({ where: { id: proposalId, run: { organizationId: actor.organizationId, userId: actor.userId } }, select: { runId: true } });
    if (!target) throw requestError("nova_proposal_not_found", "Proposal was not found.", 404);
    // Match preparation and cancellation; never hold a proposal while waiting for its run.
    await tx.$queryRaw`SELECT "id" FROM "NovaRun" WHERE "id" = ${target.runId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "NovaProposal" WHERE "id" = ${proposalId} FOR UPDATE`;
    const proposal = await tx.novaProposal.findFirst({ where: { id: proposalId, run: { organizationId: actor.organizationId, userId: actor.userId } } });
    if (!proposal) throw requestError("nova_proposal_not_found", "Proposal was not found.", 404);
    const run = await ownedRun(tx, actor, proposal.runId);
    if (proposal.fingerprint !== fingerprint) throw requestError("nova_approval_mismatch", "Approval does not match the exact proposed actions.");
    const actions = actionsSchema.parse(proposal.actions);
    const expected = novaHash({ id: proposal.id, runId: proposal.runId, actions, contextHash: proposal.contextHash, totalCredits: proposal.totalCredits, expiresAt: proposal.expiresAt.toISOString() });
    if (expected !== fingerprint) throw requestError("nova_approval_mismatch", "The proposal changed after it was prepared.");
    if (proposal.status === "EXECUTED") return { proposal: publicProposal(proposal), result: readProposalResult(proposal), replayed: true };
    if (proposal.status !== "PROPOSED" || proposal.expiresAt <= now) throw requestError("nova_approval_expired", "This proposal is closed or expired. Prepare a new one.");
    if (run.status !== "READY") throw requestError("nova_run_not_ready", "Wait for Nova to finish reviewing before approving.");
    const selection = novaSelectionSchema.parse(run.context);
    // Lock relevant data before checking the approval snapshot. Use the same job/round/credit lock order as browser invitations.
    for (const action of [...actions].sort((a, b) => a.sourceAssessmentId.localeCompare(b.sourceAssessmentId))) {
      await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id" = ${action.sourceAssessmentId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Candidate" WHERE "id" = ${action.candidateId} FOR SHARE`;
    }
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${selection.jobId} FOR SHARE`;
    const roundIds = await tx.round.findMany({ where: { jobId: selection.jobId }, select: { id: true }, orderBy: { id: "asc" } });
    for (const round of roundIds) await tx.$queryRaw`SELECT "id" FROM "Round" WHERE "id" = ${round.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${actor.organizationId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "NovaRun" WHERE "id" = ${run.id} FOR UPDATE`;
    const currentRun = await ownedRun(tx, actor, run.id);
    if (currentRun.status !== "READY") throw requestError("nova_run_not_ready", "This run changed while approval was being checked.");
    const context = await invitationContext(tx, actor, selection, actions[0]!.expiresInHours);
    if (novaHash(context.version) !== proposal.contextHash || novaHash(context.actions) !== novaHash(actions) || context.totalCredits !== proposal.totalCredits) throw requestError("nova_context_stale", "Relevant data or credit balance changed. Review and prepare a new proposal.");
    if (proposal.expiresAt <= new Date(Math.max(now.getTime(), Date.now()))) throw requestError("nova_approval_expired", "Approval expired while waiting for locked state. Prepare a new proposal.");
    await authorizeNova(tx, actor, "candidate.manage");
    const results = [];
    for (const action of actions) {
      const result = await createAssessmentInvitation(tx, actor, action, `nova-${proposal.id}-${action.candidateId}`);
      results.push({ candidateId: action.candidateId, assessmentId: result.assessment.id, launchUrl: result.launchUrl });
    }
    const saved = await tx.novaProposal.update({ where: { id: proposal.id }, data: { status: "EXECUTED", approvedAt: now, approvedById: actor.userId, executedAt: now, resultEncrypted: sealResult(proposal.id, results) } });
    await tx.novaRun.update({ where: { id: run.id }, data: { status: "COMPLETED" } });
    await tx.novaToolCall.create({ data: { runId: run.id, name: "execute_approved_invitations", arguments: { proposalId, fingerprint }, result: { assessmentIds: results.map((result) => result.assessmentId), count: results.length, credits: proposal.totalCredits }, status: "COMPLETED", completedAt: now } });
    await tx.auditEvent.create({ data: { organizationId: actor.organizationId, actorId: actor.userId, action: "nova.proposal.approved_and_executed", entityType: "nova_proposal", entityId: proposal.id, metadata: { fingerprint, count: results.length, credits: proposal.totalCredits } } });
    return { proposal: publicProposal(saved), result: results, replayed: false };
  }, { timeout: 15_000 });
}
