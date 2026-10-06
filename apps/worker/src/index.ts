import { prisma } from "@northstar/database";
import { LocalEvaluationProvider } from "@northstar/providers";
import { Worker, type ConnectionOptions } from "bullmq";

type AssessmentJob = { assessmentId: string; response: string; answers?: Record<string, string> };

if (process.env.NODE_ENV === "production") {
  throw new Error("The deterministic demo evaluator cannot run in production. Install a reviewed evaluation provider before enabling the worker.");
}

function redisConnection(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0
  };
}

const evaluator = new LocalEvaluationProvider();
const worker = new Worker<AssessmentJob>("assessment-processing", async (job) => {
  const assessment = await prisma.assessment.findUnique({
    where: { id: job.data.assessmentId },
    include: { candidate: true, round: { include: { job: { include: { requirements: true } } } } }
  });
  if (!assessment) throw new Error("Assessment not found");
  if (assessment.status === "COMPLETED") return { assessmentId: assessment.id, replayed: true };
  if (assessment.status !== "PROCESSING") throw new Error(`Assessment cannot be evaluated from ${assessment.status}`);

  const result = await evaluator.evaluate({
    assessmentId: assessment.id,
    jobDescription: assessment.round.job.description,
    response: job.data.response,
    criteria: assessment.round.job.requirements.map((criterion) => ({ name: criterion.name, weight: criterion.weight }))
  });

  await prisma.assessment.update({
    where: { id: assessment.id },
    data: {
      status: "COMPLETED",
      score: result.overallScore,
      summary: result.summary,
      completedAt: new Date(),
      launchTokenHash: null,
      evidence: { create: result.evidence.map((item) => ({ criterion: item.name, score: item.score, weight: item.weight, rationale: item.rationale, evidence: item.evidence })) }
    }
  });
  return { assessmentId: assessment.id, score: result.overallScore, advisoryOnly: true };
}, {
  connection: redisConnection(),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  limiter: { max: 20, duration: 1_000 }
});

worker.on("completed", (job) => console.info(JSON.stringify({ event: "assessment.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "assessment.failed", jobId: job?.id, message: error.message })));

async function shutdown(signal: string) {
  console.info(JSON.stringify({ event: "worker.shutdown", signal }));
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
console.info(JSON.stringify({ event: "worker.ready", queue: "assessment-processing" }));
