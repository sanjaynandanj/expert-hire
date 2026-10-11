import { assessmentAttemptLimit, assessmentLeaseMs, claimAssessmentEvaluation, completeAssessment, prisma, recoverAssessmentEvaluations, releaseAssessmentEvaluation } from "@northstar/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const now = new Date("2099-01-01T00:00:00Z");
const evaluation = { overallScore: 70, summary: "Fictional verification", evidence: [{ name: "Evidence", score: 70, weight: 100, rationale: "Fictional", evidence: "Fictional answer" }] };
let organizationId: string;
let candidateId: string;
let roundId: string;

describe.skipIf(process.env.ACCOUNT_FLOW_INTEGRATION !== "1")("durable assessment processing", () => {
  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { slug: `codex-assessment-lease-${randomUUID()}`, name: "Fictional recovery verification", type: "EMPLOYER" } });
    organizationId = org.id;
    candidateId = (await prisma.candidate.create({ data: { organizationId, name: "Fictional recovery candidate", email: `${randomUUID()}@example.test` } })).id;
    const job = await prisma.job.create({ data: { organizationId, title: "Fictional recovery role", description: "Fictional recovery verification" } });
    roundId = (await prisma.round.create({ data: { jobId: job.id, title: "Written recovery", type: "HUMAN_INTERVIEW", sequence: 1 } })).id;
  });
  afterAll(async () => { if (organizationId) await prisma.organization.delete({ where: { id: organizationId } }); });
  const row = (processingMode = "QUEUE") => prisma.assessment.create({ data: { candidateId, roundId, status: "PROCESSING", processingMode, submittedResponse: "Original persisted evaluator input.  ", submission: { q1: "Structured answer differs from evaluator input" } } });
  const claim = (id: string, clock = now) => prisma.$transaction((tx) => claimAssessmentEvaluation(tx, id, clock));

  it("claims persisted input once and fences completion against missing or wrong ownership", async () => {
    const assessment = await row();
    const claims = await Promise.all([claim(assessment.id), claim(assessment.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims.find(Boolean)!;
    expect(owner.assessment.submittedResponse).toBe("Original persisted evaluator input.  ");
    expect(owner.assessment.evaluationAttempts).toBe(1);
    await expect(prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation))).rejects.toThrow("lease");
    await expect(prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation, { token: "wrong", now }))).rejects.toThrow("lease");
    const completed = await prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation, { token: owner.token, now }));
    expect(completed.assessment).toMatchObject({ status: "COMPLETED", evaluationToken: null, evaluationExpiresAt: null });
    expect(await claim(assessment.id)).toBeNull();
    expect(await prisma.scoreEvidence.count({ where: { assessmentId: assessment.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: assessment.id, action: "assessment.completed" } })).toBe(1);
  });

  it("reclaims crashed workers without letting their late result overwrite a new owner", async () => {
    const assessment = await row();
    const old = (await claim(assessment.id))!;
    const expired = new Date(now.getTime() + assessmentLeaseMs + 1);
    await expect(prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation, { token: old.token, now: expired }))).rejects.toThrow("lease");
    const current = (await claim(assessment.id, expired))!;
    expect(current.token).not.toBe(old.token);
    expect(current.assessment.evaluationAttempts).toBe(2);
    expect(await prisma.$transaction((tx) => releaseAssessmentEvaluation(tx, assessment.id, old.token, true, expired))).toBe(false);
    await expect(prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation, { token: old.token, now: expired }))).rejects.toThrow("lease");
    await prisma.$transaction((tx) => completeAssessment(tx, assessment.id, evaluation, { token: current.token, now: expired }));
  });

  it("exhausts a database retry budget even when Redis history disappears", async () => {
    const assessment = await row();
    let clock = now;
    for (let attempt = 1; attempt <= assessmentAttemptLimit; attempt++) {
      const owner = (await claim(assessment.id, clock))!;
      expect(owner.assessment.evaluationAttempts).toBe(attempt);
      clock = new Date(clock.getTime() + assessmentLeaseMs + 1);
      expect(await prisma.$transaction((tx) => recoverAssessmentEvaluations(tx, clock, candidateId))).toEqual({ exhausted: attempt === assessmentAttemptLimit ? 1 : 0 });
    }
    expect(await claim(assessment.id, clock)).toBeNull();
    expect(await prisma.assessment.findUnique({ where: { id: assessment.id } })).toMatchObject({ status: "FAILED", evaluationAttempts: 3, evaluationToken: null });
  });

  it("does not sweep inline submissions or take active leases; releases failed attempts safely", async () => {
    const inline = await row("INLINE");
    expect(await claim(inline.id)).toBeNull();
    const assessment = await row();
    const owner = (await claim(assessment.id))!;
    expect(await claim(assessment.id)).toBeNull();
    expect(await prisma.$transaction((tx) => releaseAssessmentEvaluation(tx, assessment.id, owner.token, false, now))).toBe(true);
    const retry = (await claim(assessment.id))!;
    expect(retry.assessment.evaluationAttempts).toBe(2);
    expect(await prisma.$transaction((tx) => releaseAssessmentEvaluation(tx, assessment.id, retry.token, true, now))).toBe(true);
    expect(await prisma.assessment.findUnique({ where: { id: inline.id } })).toMatchObject({ status: "PROCESSING", evaluationAttempts: 0 });
  });
});
