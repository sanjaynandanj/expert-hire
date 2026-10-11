import { prisma } from "@northstar/database";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.env.WORKER_RECOVERY_INTEGRATION !== "1")("recovers database submissions with no Redis job and expired worker ownership", async () => {
  const org = await prisma.organization.create({ data: { slug: `codex-worker-recovery-${randomUUID()}`, name: "Fictional worker recovery", type: "EMPLOYER" } });
  let worker: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    const candidate = await prisma.candidate.create({ data: { organizationId: org.id, name: "Fictional recovery candidate", email: `${randomUUID()}@example.test` } });
    const job = await prisma.job.create({ data: { organizationId: org.id, title: "Fictional role", description: "Fictional recovery evidence", requirements: { create: { name: "Original recovery evidence", weight: 100 } } } });
    const round = await prisma.round.create({ data: { jobId: job.id, title: "Written", type: "HUMAN_INTERVIEW", sequence: 1 } });
    const rows = await Promise.all([false, true].map((expired) => prisma.assessment.create({ data: {
      candidateId: candidate.id, roundId: round.id, status: "PROCESSING", processingMode: "QUEUE",
      submittedResponse: "I gathered evidence, verified the outcome, and reviewed the original requirements with stakeholders.",
      submission: { q1: "Structured answer intentionally differs" },
      ...(expired ? { evaluationToken: "dead-worker", evaluationExpiresAt: new Date(Date.now() - 60_000), evaluationAttempts: 1 } : {})
    } })));
    // No queue.add: recovery must discover these committed database records itself.
    worker = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, NODE_ENV: "test", WORKER_HEALTH_PORT: "0", WORKER_HEALTH_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    worker.stdout?.on("data", (data) => { output = (output + data.toString()).slice(-10_000); });
    worker.stderr?.on("data", (data) => { output = (output + data.toString()).slice(-10_000); });
    await expect.poll(async () => {
      if (worker?.exitCode !== null) throw new Error(`Recovery worker exited: ${output}`);
      return prisma.assessment.count({ where: { id: { in: rows.map((row) => row.id) }, status: "COMPLETED" } });
    }, { timeout: 30_000, interval: 100 }).toBe(2);
    for (const [index, row] of rows.entries()) {
      expect(await prisma.assessment.findUnique({ where: { id: row.id }, include: { evidence: true } })).toMatchObject({ status: "COMPLETED", evaluationAttempts: index + 1, evaluationToken: null, evidence: [{ criterion: "Original recovery evidence", weight: 100 }] });
      expect(await prisma.auditEvent.count({ where: { entityId: row.id, action: "assessment.completed" } })).toBe(1);
    }
  } finally {
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      const fallback = setTimeout(() => worker?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(fallback);
    }
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
}, 40_000);
