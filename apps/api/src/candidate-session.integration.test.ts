import { prisma, Prisma, snapshotAssessmentConfiguration } from "@northstar/database";
import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

const enabled = process.env.ACCOUNT_FLOW_INTEGRATION === "1";
const app = enabled ? await buildApp() : null;
let organizationId: string;
let candidateId: string;
let writtenRoundId: string;
let codingRoundId: string;

describe.skipIf(!enabled)("candidate session authorization and transitions", () => {
  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: "Fictional candidate boundary", slug: `codex-candidate-boundary-${randomUUID()}`, type: "EMPLOYER" } });
    organizationId = org.id;
    const candidate = await prisma.candidate.create({ data: { organizationId, name: "Fictional Candidate", email: `${randomUUID()}@example.test` } });
    candidateId = candidate.id;
    const job = await prisma.job.create({ data: { organizationId, title: "Fictional role", description: "Fictional boundary verification role", requirements: { create: { name: "Reviewable evidence", weight: 100 } } } });
    writtenRoundId = (await prisma.round.create({ data: { jobId: job.id, title: "Written", type: "AI_INTERVIEW", sequence: 1 } })).id;
    codingRoundId = (await prisma.round.create({ data: { jobId: job.id, title: "Coding", type: "CODING_TEST", sequence: 2 } })).id;
  });
  afterAll(async () => {
    if (app) await app.close();
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
  });

  async function session(options: { coding?: boolean; expired?: boolean; active?: boolean } = {}) {
    const token = randomUUID();
    const assessment = await prisma.assessment.create({ data: {
      candidateId, roundId: options.coding ? codingRoundId : writtenRoundId,
      launchTokenHash: createHash("sha256").update(token).digest("hex"),
      launchExpiresAt: new Date(Date.now() + (options.expired ? -60_000 : 3_600_000)),
      status: options.active ? "IN_PROGRESS" : "PENDING",
      ...(options.active ? { consentedAt: new Date(), startedAt: new Date() } : {})
    } });
    return { token, assessment };
  }
  const actions = ["", "/consent", "/start", "/draft", "/integrity-events", "/submit"];
  it("accepts and preserves a queued submission when Redis queueing fails", async () => {
    const previous = process.env.ASSESSMENT_PROCESSING_MODE;
    const add = vi.spyOn(Queue.prototype, "add").mockRejectedValue(new Error("Fictional Redis outage"));
    process.env.ASSESSMENT_PROCESSING_MODE = "queue";
    try {
      const { token, assessment } = await session({ active: true });
      const response = await app!.inject({ method: "POST", url: `/candidate/assessments/${token}/submit`, payload: { answers: { q1: "Structured answer" }, response: "Exact original evaluator input with whitespace.  " } });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ assessment: { id: assessment.id, status: "PROCESSING" }, processing: "pending_queue" });
      expect(await prisma.assessment.findUnique({ where: { id: assessment.id } })).toMatchObject({ status: "PROCESSING", processingMode: "QUEUE", submittedResponse: "Exact original evaluator input with whitespace.", submission: { q1: "Structured answer" }, evaluationAttempts: 0 });
      expect((await action(token, "/submit")).statusCode).toBe(409);
    } finally {
      add.mockRestore();
      if (previous === undefined) delete process.env.ASSESSMENT_PROCESSING_MODE; else process.env.ASSESSMENT_PROCESSING_MODE = previous;
    }
  });
  function action(token: string, suffix: string) {
    return app!.inject({ method: suffix === "/draft" ? "PATCH" : suffix ? "POST" : "GET", url: `/candidate/assessments/${token}${suffix}`,
      ...(suffix === "/draft" ? { payload: { revision: 0, answers: {}, questionIndex: 0 } } : suffix === "/integrity-events" ? { payload: { type: "FOCUS_CHANGE" } } : suffix === "/submit" ? { payload: { response: "A meaningful fictional answer for boundary verification." } } : {}) });
  }

  it("rejects expired tokens on every action without modifying the assessment", async () => {
    const { token, assessment } = await session({ expired: true, active: true });
    for (const suffix of actions) {
      const response = await action(token, suffix);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "launch_token_invalid" } });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(await prisma.assessment.findUnique({ where: { id: assessment.id } })).toEqual(assessment);
    expect(await prisma.integrityEvent.count({ where: { assessmentId: assessment.id } })).toBe(0);
  });

  it("fails closed for coding rounds on every candidate action", async () => {
    const { token, assessment } = await session({ coding: true, active: true });
    for (const suffix of actions) {
      const response = await action(token, suffix);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "code_sandbox_unavailable" } });
    }
    expect(await prisma.assessment.findUnique({ where: { id: assessment.id } })).toEqual(assessment);
    expect(await prisma.integrityEvent.count({ where: { assessmentId: assessment.id } })).toBe(0);
  });

  it("serializes consent/start and never resets a running assessment's timing", async () => {
    const { token, assessment } = await session();
    expect((await action(token, "/start")).statusCode).toBe(409);
    const consent = await action(token, "/consent");
    expect(consent.statusCode).toBe(200);
    const repeatedConsent = await action(token, "/consent");
    expect(repeatedConsent.statusCode).toBe(200);
    expect(repeatedConsent.json().consentedAt).toBe(consent.json().consentedAt);
    const starts = await Promise.all([0, 1].map(() => action(token, "/start")));
    expect(starts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const running = await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(running.status).toBe("IN_PROGRESS");
    expect((await action(token, "/consent")).statusCode).toBe(409);
    expect((await action(token, "/start")).statusCode).toBe(409);
    expect((await action(token, "/integrity-events")).statusCode).toBe(200);
    const current = await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(current.startedAt).toEqual(running.startedAt);
    expect(current.consentedAt).toEqual(running.consentedAt);
    await prisma.assessment.update({ where: { id: assessment.id }, data: { status: "PROCESSING" } });
    expect((await action(token, "/integrity-events")).statusCode).toBe(409);
    expect(await prisma.integrityEvent.count({ where: { assessmentId: assessment.id } })).toBe(1);
  });

  it("restores partial drafts and prevents competing devices from overwriting them", async () => {
    const { token, assessment } = await session({ active: true });
    const save = (revision: number, answer: string) => app!.inject({ method: "PATCH", url: `/candidate/assessments/${token}/draft`, payload: { revision, answers: { q1: answer, q2: "" }, questionIndex: 1 } });
    const first = await save(0, "Partial answer with whitespace preserved.  ");
    expect(first.statusCode).toBe(200);
    expect(first.json().revision).toBe(1);
    const restored = (await action(token, "")).json().assessment;
    expect(restored).toMatchObject({ startedAt: assessment.startedAt!.toISOString(), draftRevision: 1, draft: { answers: { q1: "Partial answer with whitespace preserved.  ", q2: "" }, questionIndex: 1 } });
    const competitors = await Promise.all([save(1, "First device answer"), save(1, "Second device answer")]);
    expect(competitors.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const row = await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(row.draftRevision).toBe(2);
    const staleSubmit = await app!.inject({ method: "POST", url: `/candidate/assessments/${token}/submit`, payload: { draftRevision: 1, response: "A meaningful answer from a stale device that must not replace newer work." } });
    expect(staleSubmit.statusCode).toBe(409);
    expect((await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).submission).toBeNull();
    const previousMode = process.env.ASSESSMENT_PROCESSING_MODE;
    try {
      process.env.ASSESSMENT_PROCESSING_MODE = "inline";
      const currentSubmit = await app!.inject({ method: "POST", url: `/candidate/assessments/${token}/submit`, payload: { draftRevision: 2, answers: { q1: "The final candidate answer" }, response: "The final candidate answer contains meaningful reviewable evidence." } });
      expect(currentSubmit.statusCode).toBe(200);
      expect(await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).toMatchObject({ status: "COMPLETED", draft: null, submission: { q1: "The final candidate answer" } });
    } finally {
      if (previousMode === undefined) delete process.env.ASSESSMENT_PROCESSING_MODE;
      else process.env.ASSESSMENT_PROCESSING_MODE = previousMode;
    }
    expect((await save(2, "Too late")).statusCode).toBe(401);
    expect((await action(token, "")).statusCode).toBe(401);
  });

  it("rejects pre-consent drafts and oversized or malformed drafts", async () => {
    const { token, assessment } = await session();
    expect((await action(token, "/draft")).statusCode).toBe(409);
    await prisma.assessment.update({ where: { id: assessment.id }, data: { status: "IN_PROGRESS", consentedAt: new Date(), startedAt: new Date() } });
    for (const payload of [
      { revision: -1, answers: {}, questionIndex: 0 },
      { revision: 0, answers: { q1: "a".repeat(10_001) }, questionIndex: 0 },
      { revision: 0, answers: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`q${index}`, "a".repeat(10_000)])), questionIndex: 0 },
      { revision: 0, answers: {}, questionIndex: 100 }
    ]) {
      expect((await app!.inject({ method: "PATCH", url: `/candidate/assessments/${token}/draft`, payload })).statusCode).toBe(422);
    }
    expect(await prisma.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).toMatchObject({ draft: null, draftRevision: 0 });
  });

  it("evaluates against the frozen rubric after live criteria and round type change", async () => {
    const { token, assessment } = await session({ active: true });
    const original = await prisma.round.findUniqueOrThrow({ where: { id: writtenRoundId }, include: { job: { include: { requirements: true } } } });
    await prisma.assessment.update({ where: { id: assessment.id }, data: { configuration: snapshotAssessmentConfiguration(original) as unknown as Prisma.InputJsonValue } });
    await prisma.job.update({ where: { id: original.jobId }, data: { description: "A different role description", requirements: { deleteMany: {}, create: { name: "Changed live criterion", weight: 100 } } } });
    await prisma.round.update({ where: { id: writtenRoundId }, data: { type: "CODING_TEST", title: "Changed live round", durationMinutes: 55 } });
    const launch = await action(token, "");
    expect(launch.statusCode).toBe(200);
    expect(launch.json().assessment).toMatchObject({ type: "AI_INTERVIEW", roundTitle: "Written", durationMinutes: 20 });
    const previousMode = process.env.ASSESSMENT_PROCESSING_MODE;
    try {
      process.env.ASSESSMENT_PROCESSING_MODE = "inline";
      const response = await app!.inject({ method: "POST", url: `/candidate/assessments/${token}/submit`, payload: { response: "Reviewable evidence demonstrates the original criterion with concrete monitored outcomes." } });
      expect(response.statusCode).toBe(200);
      expect(response.json().assessment.evidence).toHaveLength(1);
      expect(response.json().assessment.evidence[0]).toMatchObject({ criterion: "Reviewable evidence", weight: 100 });
    } finally {
      if (previousMode === undefined) delete process.env.ASSESSMENT_PROCESSING_MODE;
      else process.env.ASSESSMENT_PROCESSING_MODE = previousMode;
    }
  });
});
