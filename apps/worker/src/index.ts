import { assessmentAttemptLimit, claimAssessmentEvaluation, claimWebhookDelivery, completeAssessment, finishWebhookDelivery, prisma, recoverAssessmentEvaluations, recoverWebhookDeliveries, releaseAssessmentEvaluation, resolveAssessmentConfiguration, webhookAttemptLimit } from "@northstar/database";
import { authorizeMetrics, createReadinessProbe, decryptWebhookSecret, enqueuePersistedJobs, enqueuePersistedWebhooks, LocalEvaluationProvider, metricsContentType, OperationsMetrics, readMetricsToken, sendSignedWebhook, type WorkerOutcome, type WorkerTask } from "@northstar/providers";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import IORedis from "ioredis";
import { createServer } from "node:http";

type AssessmentJob = { assessmentId: string; response?: string; answers?: Record<string, string> };
type WebhookJob = { deliveryId?: string };
const metricsToken = readMetricsToken();
const metrics = new OperationsMetrics();

function recordJobOutcome(task: WorkerTask, job: Job | undefined, failed = false) {
  const value = job?.returnvalue;
  const result = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const outcome: WorkerOutcome = failed
    ? job && job.attemptsMade < (job.opts.attempts ?? 1) ? "retry" : "failed"
    : result.failed ? "failed" : result.blocked ? "blocked" : result.skipped ? "skipped" : "completed";
  metrics.recordJob(task, outcome, job?.processedOn ? Math.max(0, ((job.finishedOn ?? Date.now()) - job.processedOn) / 1_000) : 0);
}

function redisConnection(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0
  };
}

const webhookQueue = new Queue("webhook-delivery", { connection: redisConnection() });
void webhookQueue.upsertJobScheduler("pending-delivery-sweep", { every: 60_000 }, { name: "sweep", data: {} })
  .catch((error: unknown) => console.error(JSON.stringify({ event: "webhook.sweep.schedule.failed", message: error instanceof Error ? error.message : "Unknown error" })));
const retentionGraceDays = Number(process.env.EPHEMERAL_RETENTION_GRACE_DAYS ?? 30);
if (!Number.isInteger(retentionGraceDays) || retentionGraceDays < 1 || retentionGraceDays > 365) throw new Error("EPHEMERAL_RETENTION_GRACE_DAYS must be an integer from 1 to 365.");
void webhookQueue.upsertJobScheduler("ephemeral-retention-sweep", { every: 24 * 60 * 60_000 }, { name: "retention-sweep", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 500 } })
  .catch((error: unknown) => console.error(JSON.stringify({ event: "retention.sweep.schedule.failed", message: error instanceof Error ? error.message : "Unknown error" })));

async function addRecoverableWebhookDelivery(id: string) {
  const previous = await webhookQueue.getJob(id);
  if (previous && ["completed", "failed"].includes(await previous.getState())) await previous.remove();
  return webhookQueue.add("deliver", { deliveryId: id }, { jobId: id, attempts: 6, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 2_000, removeOnFail: 5_000 });
}

const evaluator = new LocalEvaluationProvider();
const workers: Array<{ close: () => Promise<void> }> = [];
const assessmentQueue = process.env.NODE_ENV !== "production" ? new Queue<AssessmentJob>("assessment-processing", { connection: redisConnection() }) : null;
async function addRecoverableAssessment(id: string) {
  if (!assessmentQueue) return;
  const previous = await assessmentQueue.getJob(id);
  if (previous && ["completed", "failed"].includes(await previous.getState())) await previous.remove();
  return assessmentQueue.add("evaluate", { assessmentId: id }, { jobId: id, attempts: assessmentAttemptLimit, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 });
}
async function sweepAssessments() {
  const recovery = await prisma.$transaction((tx) => recoverAssessmentEvaluations(tx));
  const pending = await prisma.assessment.findMany({ where: {
    status: "PROCESSING", processingMode: "QUEUE", submittedResponse: { not: null }, evaluationAttempts: { lt: assessmentAttemptLimit },
    OR: [{ evaluationExpiresAt: null }, { evaluationExpiresAt: { lte: new Date() } }]
  }, select: { id: true }, take: 500, orderBy: { updatedAt: "asc" } });
  await enqueuePersistedJobs(pending.map((row) => row.id), addRecoverableAssessment,
    (id, error) => console.error(JSON.stringify({ event: "assessment.sweep.deferred", assessmentId: id, message: error instanceof Error ? error.message : "Unknown error" })));
  return { attempted: pending.length, ...recovery };
}
if (process.env.NODE_ENV !== "production") {
void webhookQueue.upsertJobScheduler("pending-assessment-sweep", { every: 60_000 }, { name: "assessment-sweep", data: {} })
  .catch((error: unknown) => console.error(JSON.stringify({ event: "assessment.sweep.schedule.failed", message: error instanceof Error ? error.message : "Unknown error" })));
void sweepAssessments().catch((error: unknown) => console.error(JSON.stringify({ event: "assessment.sweep.failed", message: error instanceof Error ? error.message : "Unknown error" })));
const worker = new Worker<AssessmentJob>("assessment-processing", async (job) => {
  // Adopt older Redis jobs only when their original input is still available.
  if (job.data.response !== undefined) await prisma.assessment.updateMany({ where: { id: job.data.assessmentId, status: "PROCESSING", processingMode: null }, data: { submittedResponse: job.data.response, processingMode: "QUEUE" } });
  const claim = await prisma.$transaction((tx) => claimAssessmentEvaluation(tx, job.data.assessmentId));
  if (!claim) return { assessmentId: job.data.assessmentId, skipped: true };
  const { assessment, token } = claim;
  try {
  const configuration = resolveAssessmentConfiguration(assessment);
  if (configuration.round.type === "CODING_TEST") {
    await prisma.$transaction((tx) => releaseAssessmentEvaluation(tx, assessment.id, token, true));
    return { assessmentId: assessment.id, blocked: "isolated_code_runner_unavailable" };
  }

  const result = await evaluator.evaluate({
    assessmentId: assessment.id,
    jobDescription: configuration.job.description,
    response: assessment.submittedResponse ?? job.data.response ?? "",
    criteria: configuration.job.requirements.map((criterion) => ({ name: criterion.name, weight: criterion.weight }))
  });

  const completed = await prisma.$transaction((tx) => completeAssessment(tx, assessment.id, result, { token }));
  await enqueuePersistedWebhooks(completed.deliveries, addRecoverableWebhookDelivery,
    (id, error) => console.error(JSON.stringify({ event: "webhook.enqueue.deferred", deliveryId: id, message: error instanceof Error ? error.message : "Unknown error" })));
  return { assessmentId: assessment.id, score: completed.assessment.score, advisoryOnly: true, replayed: completed.replayed };
  } catch (error) {
    const saved = await prisma.$transaction((tx) => releaseAssessmentEvaluation(tx, assessment.id, token));
    if (!saved) return { assessmentId: assessment.id, skipped: true, staleLease: true };
    if (assessment.evaluationAttempts >= assessmentAttemptLimit) return { assessmentId: assessment.id, failed: true };
    throw error;
  }
}, {
  connection: redisConnection(),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  limiter: { max: 20, duration: 1_000 }
});
workers.push(worker);

worker.on("completed", (job) => { recordJobOutcome("assessment", job); console.info(JSON.stringify({ event: "assessment.completed", jobId: job.id })); });
worker.on("failed", (job, error) => { recordJobOutcome("assessment", job, true); console.error(JSON.stringify({ event: "assessment.failed", jobId: job?.id, message: error.message })); });
worker.on("error", (error) => console.error(JSON.stringify({ event: "assessment.worker.error", message: error.message })));
}

const webhookWorker = new Worker<WebhookJob>("webhook-delivery", async (job) => {
  if (job.name === "assessment-sweep") return assessmentQueue ? sweepAssessments() : { skipped: true };
  if (job.name === "retention-sweep") {
    const now = new Date();
    const cutoff = new Date(now.getTime() - retentionGraceDays * 24 * 60 * 60_000);
    const [sessions, accountTokens, invitations, usedRecoveryCodes, expiredLaunchTokens] = await prisma.$transaction([
      prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } }),
      prisma.accountToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }] } }),
      prisma.workspaceInvitation.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { acceptedAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } }),
      prisma.mfaRecoveryCode.deleteMany({ where: { usedAt: { lt: cutoff } } }),
      prisma.assessment.updateMany({ where: { status: "PENDING", launchTokenHash: { not: null }, launchExpiresAt: { lt: now } }, data: { launchTokenHash: null, launchExpiresAt: null } })
    ]);
    const result = { sessions: sessions.count, accountTokens: accountTokens.count, invitations: invitations.count, usedRecoveryCodes: usedRecoveryCodes.count, expiredLaunchTokens: expiredLaunchTokens.count, graceDays: retentionGraceDays };
    console.info(JSON.stringify({ event: "retention.sweep.completed", ...result }));
    return result;
  }
  if (job.name === "sweep") {
    const recovery = await prisma.$transaction((tx) => recoverWebhookDeliveries(tx));
    const pending = await prisma.webhookDelivery.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: new Date() } }, select: { id: true }, take: 500, orderBy: { nextAttemptAt: "asc" } });
    await enqueuePersistedWebhooks(pending.map((delivery) => delivery.id), addRecoverableWebhookDelivery,
      (id, error) => console.error(JSON.stringify({ event: "webhook.sweep.deferred", deliveryId: id, message: error instanceof Error ? error.message : "Unknown error" })));
    return { attempted: pending.length, ...recovery };
  }
  if (!job.data.deliveryId) return { skipped: true };
  const claim = await prisma.$transaction((tx) => claimWebhookDelivery(tx, job.data.deliveryId!));
  if (!claim) return { deliveryId: job.data.deliveryId, skipped: true };
  const { delivery, token } = claim;
  if (!delivery.endpoint.active || !delivery.endpoint.secretEncrypted) {
    await finishWebhookDelivery(prisma, delivery.id, token, { status: "FAILED", statusCode: null, error: "Endpoint is disabled or its signing secret is unavailable." });
    return { deliveryId: delivery.id, skipped: true };
  }
  try {
    const result = await sendSignedWebhook({ url: delivery.endpoint.url, secret: decryptWebhookSecret(delivery.endpoint.secretEncrypted), eventId: delivery.eventId, eventType: delivery.eventType, payload: delivery.payload });
    const saved = await finishWebhookDelivery(prisma, delivery.id, token, { status: "DELIVERED", statusCode: result.statusCode, error: null });
    if (!saved) return { deliveryId: delivery.id, skipped: true, staleLease: true };
    return { deliveryId: delivery.id, statusCode: result.statusCode };
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
    const retryable = statusCode === null || statusCode === 429 || statusCode >= 500;
    const willRetry = retryable && delivery.attemptCount < webhookAttemptLimit;
    const saved = await finishWebhookDelivery(prisma, delivery.id, token, { status: willRetry ? "PENDING" : "FAILED", statusCode, error: error instanceof Error ? error.message.slice(0, 1000) : "Webhook delivery failed.", nextAttemptAt: willRetry ? new Date(Date.now() + Math.min(2 ** (delivery.attemptCount - 1) * 2_000, 300_000)) : new Date() });
    if (!saved) return { deliveryId: delivery.id, skipped: true, staleLease: true };
    if (willRetry) throw error;
    return { deliveryId: delivery.id, statusCode, failed: true };
  }
}, { connection: redisConnection(), concurrency: Number(process.env.WEBHOOK_CONCURRENCY ?? 8), limiter: { max: 100, duration: 1_000 } });
workers.push(webhookWorker);
const webhookTask = (job: Job | undefined): WorkerTask => job?.name === "retention-sweep" ? "retention" : job?.name === "sweep" ? "webhook_sweep" : "webhook_delivery";
webhookWorker.on("completed", (job) => { recordJobOutcome(webhookTask(job), job); console.info(JSON.stringify({ event: "webhook.delivery.finished", jobId: job.id })); });
webhookWorker.on("failed", (job, error) => { recordJobOutcome(webhookTask(job), job, true); console.error(JSON.stringify({ event: "webhook.delivery.failed", jobId: job?.id, message: error.message })); });
webhookWorker.on("error", (error) => console.error(JSON.stringify({ event: "webhook.worker.error", message: error.message })));

const healthRedis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, connectTimeout: 2_000, retryStrategy: (attempt) => Math.min(attempt * 250, 1_000) });
const probeDatabase = createReadinessProbe(() => prisma.$queryRaw`SELECT 1`);
const probeRedis = createReadinessProbe(async () => {
  if (await healthRedis.ping() !== "PONG") throw new Error("Worker Redis did not respond to its readiness probe.");
});
const healthServer = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" || !["/health", "/ready", "/metrics"].includes(request.url ?? "")) {
    response.writeHead(404).end(JSON.stringify({ status: "not_found" }));
    return;
  }
  if (request.url === "/metrics") {
    if (!metricsToken) { response.writeHead(404).end(JSON.stringify({ status: "not_found" })); return; }
    if (!authorizeMetrics(request.headers.authorization, metricsToken)) { response.setHeader("WWW-Authenticate", "Bearer"); response.writeHead(401).end(JSON.stringify({ status: "unauthorized" })); return; }
    response.setHeader("Content-Type", metricsContentType);
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200).end(metrics.render());
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200).end(JSON.stringify({ status: "ok", service: "northstar-worker" }));
    return;
  }
  try {
    await Promise.all([probeDatabase(), probeRedis()]);
    if (!webhookWorker.isRunning()) throw new Error("Webhook delivery worker is not running.");
    response.writeHead(200).end(JSON.stringify({ status: "ready", dependencies: { database: "ok", redis: "ok", webhookWorker: "ok", assessmentWorker: process.env.NODE_ENV === "production" ? "disabled_until_reviewed_sandbox" : "enabled" } }));
  } catch (error) {
    console.error(JSON.stringify({ event: "worker.readiness.failed", message: error instanceof Error ? error.message : "Dependency check failed." }));
    response.writeHead(503).end(JSON.stringify({ status: "not_ready" }));
  }
});
healthServer.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4001), process.env.WORKER_HEALTH_HOST ?? "0.0.0.0", () => {
  console.info(JSON.stringify({ event: "worker.health.listening", port: Number(process.env.WORKER_HEALTH_PORT ?? 4001) }));
});

async function shutdown(signal: string) {
  console.info(JSON.stringify({ event: "worker.shutdown", signal }));
  await Promise.all(workers.map((worker) => worker.close()));
  await webhookQueue.close();
  await assessmentQueue?.close();
  healthRedis.disconnect();
  if (healthServer.listening) await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
console.info(JSON.stringify({ event: "worker.ready", queues: { assessmentProcessing: process.env.NODE_ENV !== "production", webhookDelivery: true } }));
