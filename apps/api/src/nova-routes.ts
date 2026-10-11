import { prisma, Prisma } from "@northstar/database";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requestError } from "./assessment-invitations";
import { createNovaProvider, novaAvailability, type NovaModelProvider } from "./nova-provider";
import { cancelNovaRun, processNovaRun, readNovaRun, recoverNovaRuns } from "./nova-runtime";
import { approveNovaProposal, authorizeNova, novaSelectionSchema, type NovaActor } from "./nova-tools";

export type NovaDependencies = { provider?: () => NovaModelProvider; availability?: typeof novaAvailability; backgroundRecovery?: boolean };
const actor = (request: FastifyRequest): NovaActor => ({ organizationId: request.organizationId, userId: request.currentUserId, sessionId: request.currentSessionId });
export async function registerNovaRoutes(app: FastifyInstance, dependencies: NovaDependencies = {}) {
  const availability = dependencies.availability ?? novaAvailability;
  const provider = dependencies.provider ?? createNovaProvider;
  async function allowed(request: FastifyRequest) {
    await prisma.$transaction(async (tx) => {
      for (const permission of ["job.read", "candidate.read", "report.read"] as const) await authorizeNova(tx, actor(request), permission);
    });
  }
  app.addHook("onSend", async (request, reply) => { if (request.url.startsWith("/v1/nova")) reply.header("Cache-Control", "no-store"); });
  app.get("/nova/status", async (request) => { await allowed(request); return availability(); });
  app.get<{ Querystring: { jobId?: string; afterId?: string } }>("/nova/options", async (request) => {
    await allowed(request);
    const roles = await prisma.job.findMany({ where: { organizationId: request.organizationId }, select: { id: true, title: true, rounds: { where: { retiredAt: null, type: { not: "CODING_TEST" } }, select: { id: true, title: true, sequence: true }, orderBy: { sequence: "asc" } } }, orderBy: { id: "asc" }, take: 100 });
    const jobId = request.query.jobId;
    if (jobId && !roles.some((role) => role.id === jobId)) throw requestError("nova_target_not_found", "Role was not found.", 404);
    const rows = jobId ? await prisma.assessment.findMany({ where: { status: "COMPLETED", candidate: { organizationId: request.organizationId }, round: { jobId }, ...(request.query.afterId ? { id: { gt: request.query.afterId } } : {}) }, select: { id: true, candidateId: true, candidate: { select: { name: true } }, round: { select: { title: true, sequence: true } }, _count: { select: { evidence: true } } }, orderBy: { id: "asc" }, take: 21 }) : [];
    return { roles, assessments: rows.slice(0, 20).map(({ _count, ...row }) => ({ ...row, evidenceCount: _count.evidence })), nextCursor: rows.length > 20 ? rows[19]!.id : null };
  });
  app.get("/nova/runs", async (request) => {
    await allowed(request);
    return { runs: await prisma.novaRun.findMany({ where: { organizationId: request.organizationId, userId: request.currentUserId }, select: { id: true, status: true, message: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 30 }) };
  });
  app.get<{ Params: { id: string } }>("/nova/runs/:id", async (request) => { await allowed(request); return readNovaRun(actor(request), request.params.id); });
  app.post("/nova/runs", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    await allowed(request);
    const input = z.object({ message: z.string().trim().min(1).max(4000), selection: novaSelectionSchema, parentRunId: z.string().min(1).max(200).optional() }).strict().safeParse(request.body);
    if (!input.success) throw requestError("nova_request_invalid", "Enter a request and valid role/candidate selection.", 422);
    if (!availability().configured) throw requestError("nova_provider_unavailable", availability().reason ?? "Nova is unavailable.", 503);
    const job = await prisma.job.findFirst({ where: { id: input.data.selection.jobId, organizationId: request.organizationId }, select: { id: true } });
    if (!job) throw requestError("nova_target_not_found", "Role was not found.", 404);
    const run = await prisma.$transaction(async (tx) => {
      for (const permission of ["job.read", "candidate.read", "report.read"] as const) await authorizeNova(tx, actor(request), permission);
      let conversation: Prisma.InputJsonValue = [];
      if (input.data.parentRunId) {
        await tx.$queryRaw`SELECT "id" FROM "NovaRun" WHERE "id" = ${input.data.parentRunId} AND "organizationId" = ${request.organizationId} AND "userId" = ${request.currentUserId} FOR UPDATE`;
        const parent = await tx.novaRun.findFirst({ where: { id: input.data.parentRunId, organizationId: request.organizationId, userId: request.currentUserId } });
        if (!parent) throw requestError("nova_run_not_found", "Previous review was not found.", 404);
        if (!["READY", "COMPLETED"].includes(parent.status) || !parent.response) throw requestError("nova_followup_unavailable", "Finish this review before following up, or start a new conversation.");
        if (novaSelectionSchema.parse(parent.context).jobId !== input.data.selection.jobId) throw requestError("nova_followup_role_mismatch", "Start a new conversation to review a different role.", 422);
        // Carry only validated review discussion, never protocol frames, proposal
        // fingerprints, approval decisions, contact details or invitation secrets.
        const response = parent.response as { message: string; summaries: Array<{ assessmentId: string; observations: unknown[] }> };
        const summaries = response.summaries.map(({ assessmentId, observations }) => ({ assessmentId, observations }));
        const turns = [...(Array.isArray(parent.conversation) ? parent.conversation : []), { message: parent.message, response: { message: response.message, summaries } }].slice(-6);
        if (JSON.stringify(turns).length > 80_000) throw requestError("nova_conversation_limit", "Start a new conversation; this discussion reached its context limit.");
        conversation = JSON.parse(JSON.stringify(turns)) as Prisma.InputJsonValue;
        if (parent.status === "READY") {
          await tx.novaProposal.updateMany({ where: { runId: parent.id, status: "PROPOSED" }, data: { status: "SUPERSEDED" } });
          await tx.novaRun.update({ where: { id: parent.id }, data: { status: "SUPERSEDED" } });
        }
      }
      return tx.novaRun.create({ data: { organizationId: request.organizationId, userId: request.currentUserId, sessionId: request.currentSessionId, parentRunId: input.data.parentRunId ?? null, conversation, message: input.data.message, context: input.data.selection, provider: availability().protocol, model: availability().model } });
    });
    void Promise.resolve().then(() => processNovaRun(actor(request), run.id, provider())).catch(async () => {
      await prisma.novaRun.updateMany({ where: { id: run.id, status: "PENDING", processingToken: null }, data: { status: "FAILED", errorCode: "nova_start_unavailable" } });
    });
    return reply.status(202).send({ id: run.id, status: "PENDING" });
  });
  app.post<{ Params: { id: string } }>("/nova/runs/:id/cancel", async (request) => {
    await allowed(request);
    await cancelNovaRun(actor(request), request.params.id);
    return readNovaRun(actor(request), request.params.id);
  });
  app.post<{ Params: { id: string } }>("/nova/proposals/:id/approve", async (request) => {
    await allowed(request);
    if (!availability().configured) throw requestError("nova_provider_unavailable", availability().reason ?? "Nova is unavailable.", 503);
    const input = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict().safeParse(request.body);
    if (!input.success) throw requestError("nova_approval_required", "Explicit approval of the exact proposal is required.", 422);
    return approveNovaProposal(actor(request), request.params.id, input.data.fingerprint);
  });
  let recovering = false;
  const tick = () => {
    if (dependencies.backgroundRecovery === false || recovering || !availability().configured) return;
    recovering = true;
    void recoverNovaRuns(provider).catch(() => undefined).finally(() => { recovering = false; });
  };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  app.addHook("onReady", async () => { tick(); });
  app.addHook("onClose", async () => { clearInterval(timer); });
}
