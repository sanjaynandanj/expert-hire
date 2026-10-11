import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { completeAssessment, persistWebhookEvent, prisma, Prisma, resolveAssessmentConfiguration } from "@northstar/database";
import { canTransitionAssessment, checkPlacementEligibility, hasPermission, jobSchema, type Permission, type Role } from "@northstar/domain";
import { authorizeMetrics, createReadinessProbe, encryptWebhookSecret, enqueuePersistedJobs, enqueuePersistedWebhooks, LocalBillingProvider, LocalEvaluationProvider, metricsContentType, OperationsMetrics, readMetricsToken, validateWebhookDestination } from "@northstar/providers";
import { Queue, type ConnectionOptions } from "bullmq";
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { createSessionToken, readSessionToken } from "./auth";
import { createRecoveryCodes, createTotpSecret, decryptTotpSecret, encryptTotpSecret, totpUri, verifyTotp } from "./mfa";
import { afterPublicCursor, publicPage, publicPaginationSchema } from "./public-pagination";
import { createAssessmentInvitation } from "./assessment-invitations";
import { registerNovaRoutes, type NovaDependencies } from "./nova-routes";

declare module "fastify" {
  interface FastifyRequest {
    organizationId: string;
    currentUserId: string;
    currentSessionId: string;
    membershipRole: Role;
    apiKeyOrganizationId: string;
    apiKeyScopes: string[];
    apiKeyId: string;
  }
}

const organizationHeader = z.string().min(1);
const localEvaluator = new LocalEvaluationProvider();
const localBilling = new LocalBillingProvider();
let assessmentQueue: Queue | null = null;
let webhookQueue: Queue | null = null;

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

function getAssessmentQueue() {
  assessmentQueue ??= new Queue("assessment-processing", { connection: redisConnection() });
  return assessmentQueue;
}

function getWebhookQueue() {
  webhookQueue ??= new Queue("webhook-delivery", { connection: redisConnection() });
  return webhookQueue;
}

async function queueWebhookDeliveries(ids: string[]) {
  await enqueuePersistedWebhooks(ids, async (id) => {
    const queue = getWebhookQueue();
    const previous = await queue.getJob(id);
    if (previous && ["completed", "failed"].includes(await previous.getState())) await previous.remove();
    return queue.add("deliver", { deliveryId: id }, { jobId: id, attempts: 6, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 2_000, removeOnFail: 5_000 });
  },
    (id, error) => console.error(JSON.stringify({ event: "webhook.enqueue.deferred", deliveryId: id, message: error instanceof Error ? error.message : "Unknown error" })));
}

async function createStudentNotification(tx: Prisma.TransactionClient, input: { userId: string; organizationId: string; type: string; title: string; body: string; data?: Record<string, unknown> }) {
  return tx.userNotification.create({ data: {
    userId: input.userId,
    organizationId: input.organizationId,
    type: input.type,
    title: input.title,
    body: input.body,
    data: (input.data ?? {}) as Prisma.InputJsonValue
  } });
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function accountToken() {
  return randomBytes(32).toString("base64url");
}

function accountLink(path: string, token: string) {
  const base = process.env.WEB_URL ?? "http://localhost:3000";
  return new URL(`${path}?token=${encodeURIComponent(token)}`, base).toString();
}

async function authenticatedUserId(request: FastifyRequest) {
  const token = request.cookies.northstar_session;
  const identity = token ? await readSessionToken(token) : null;
  if (!identity) throw forbidden("session_required", "Sign in to continue.", 401);
  const session = await prisma.session.findFirst({ where: { id: identity.sessionId, userId: identity.userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
  if (!session) throw forbidden("session_required", "Sign in to continue.", 401);
  return identity.userId;
}

function registrationSlug(name: string) {
  const base = name.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "workspace";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

async function deliverAccountEmail(input: { to: string; subject: string; link: string; action: string }) {
  const body = `Use this link to ${input.action}:\n\n${input.link}\n\nIf you did not request this, you can ignore this email.`;
  if (process.env.NODE_ENV !== "production") {
    const mailpitUrl = process.env.MAILPIT_API_URL ?? "http://localhost:8025/api/v1/send";
    try {
      const response = await fetch(mailpitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: { Email: "no-reply@northstar.local", Name: "Northstar" },
          To: [{ Email: input.to }],
          Subject: input.subject,
          Text: body
        }),
        signal: AbortSignal.timeout(2_000)
      });
      if (!response.ok) console.warn(`Local account email preview was not delivered (Mailpit returned ${response.status}).`);
    } catch {
      console.warn("Local account email preview was not delivered; use the returned development action link.");
    }
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw forbidden("email_delivery_unavailable", "Account email delivery is not configured.", 503);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: body }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw forbidden("email_delivery_failed", "The account email could not be delivered. Try again later.", 503);
}

function requestOrganization(request: FastifyRequest): string {
  const parsed = organizationHeader.safeParse(request.headers["x-organization-id"]);
  if (!parsed.success) {
    const error = new Error("Choose an organization before using this endpoint.");
    Object.assign(error, { statusCode: 400, code: "organization_required" });
    throw error;
  }
  return parsed.data;
}

function forbidden(code: string, message: string, statusCode = 403) {
  const error = new Error(message);
  Object.assign(error, { statusCode, code });
  return error;
}

function requirePermission(request: FastifyRequest, permission: Permission) {
  if (!hasPermission(request.membershipRole, permission)) {
    throw forbidden("permission_denied", "Your workspace role does not allow this action.");
  }
}

function requireApiKeyScope(request: FastifyRequest, scope: string) {
  if (!request.apiKeyScopes.includes("*") && !request.apiKeyScopes.includes(scope)) throw forbidden("api_key_scope_missing", `This API key needs the ${scope} scope.`, 403);
}

function assertSameOriginForStateChanges(request: FastifyRequest, allowedOrigins: ReadonlySet<string>) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.origin;
  // An explicitly trusted frontend can be cross-site relative to the API.
  // Fetch metadata is a fallback only when the browser omits Origin.
  if (origin ? !allowedOrigins.has(origin) : request.headers["sec-fetch-site"] === "cross-site") {
    throw forbidden("cross_origin_request", "Cross-origin state changes are not allowed.", 403);
  }
}

export async function buildApp(options: { nova?: NovaDependencies } = {}) {
  const metricsToken = readMetricsToken();
  const metrics = new OperationsMetrics();
  const production = process.env.NODE_ENV === "production";
  const configuredSessionSecret = process.env.SESSION_SECRET;
  const webUrl = process.env.WEB_URL;
  if (production && (!configuredSessionSecret || configuredSessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters in production");
  }
  if (production && (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length < 32)) {
    throw new Error("MFA_ENCRYPTION_KEY must be configured with at least 32 characters in production");
  }
  if (production && (!process.env.WEBHOOK_ENCRYPTION_KEY || process.env.WEBHOOK_ENCRYPTION_KEY.length < 32)) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY must be configured with at least 32 characters in production");
  }
  if (production && process.env.AI_PROVIDER === "local") throw new Error("The local demo assessment evaluator is disabled in production; configure a reviewed assessment provider.");
  if (production && process.env.BILLING_PROVIDER === "local") throw new Error("The local fake billing provider is disabled in production; configure a payment provider.");
  if (production && !webUrl) throw new Error("WEB_URL must be configured in production");
  if (production && new URL(webUrl as string).protocol !== "https:") {
    throw new Error("WEB_URL must use HTTPS in production");
  }
  const allowedWebOrigin = webUrl ? new URL(webUrl).origin : "http://localhost:3000";
  const allowedBrowserOrigins = new Set(production ? [allowedWebOrigin] : [allowedWebOrigin, "http://localhost:3000", "http://127.0.0.1:3000"]);
  const apiRateLimit = Number(process.env.API_RATE_LIMIT_MAX ?? (production ? 150 : 1_000));
  if (!Number.isSafeInteger(apiRateLimit) || apiRateLimit < 1) throw new Error("API_RATE_LIMIT_MAX must be a positive integer");
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.url", "body.password"]
    },
    requestIdHeader: "x-request-id"
  });

  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url !== "/metrics") metrics.recordHttp(request.method, request.routeOptions.url, reply.statusCode, reply.elapsedTime / 1_000);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: configuredSessionSecret ?? "local-development-secret-change-me" });
  await app.register(cors, {
    origin: [...allowedBrowserOrigins],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });
  await app.register(rateLimit, { max: apiRateLimit, timeWindow: "1 minute", allowList: (request) => request.method === "OPTIONS" });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Northstar API",
        description: "Tenant-scoped talent intelligence and assessment API.",
        version: "0.1.0"
      },
      servers: [{ url: process.env.API_URL ?? "http://localhost:4000" }]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error, request, reply) => {
    const normalized = error instanceof Error ? error : new Error("Unknown request failure");
    const details = normalized as Error & { statusCode?: number; code?: string };
    const statusCode = typeof details.statusCode === "number" ? details.statusCode : 500;
    const code = typeof details.code === "string" ? details.code : "internal_error";
    if (statusCode >= 500) request.log.error(normalized);
    return reply.status(statusCode).send({
      error: {
        type: statusCode >= 500 ? "api_error" : "request_error",
        code,
        message: statusCode >= 500 ? "The request could not be completed." : normalized.message,
        request_id: request.id
      }
    });
  });

  app.get("/health", {
    schema: { tags: ["System"], summary: "Liveness check" }
  }, async () => ({ status: "ok", service: "northstar-api" }));

  app.get("/metrics", { schema: { hide: true } }, async (request, reply) => {
    if (!metricsToken) return reply.status(404).send({ error: { code: "not_found" } });
    if (!authorizeMetrics(request.headers.authorization, metricsToken)) return reply.header("WWW-Authenticate", "Bearer").status(401).send({ error: { code: "metrics_authentication_required" } });
    return reply.header("Cache-Control", "no-store").type(metricsContentType).send(metrics.render());
  });

  const probeDatabase = createReadinessProbe(() => prisma.$queryRaw`SELECT 1`);
  const probeQueue = createReadinessProbe(async () => {
    const queue = getAssessmentQueue();
    await queue.waitUntilReady();
    const client = await queue.getBackend().client;
    // BullMQ's pinned ioredis adapter forwards PING, but its portable interface
    // omits it. Fail closed if a future backend does not provide that command.
    if (!("ping" in client) || typeof client.ping !== "function") throw new Error("Queue Redis does not support readiness PING.");
    if (await client.ping() !== "PONG") throw new Error("Queue Redis did not respond to its readiness probe.");
  });
  app.get("/ready", {
    schema: { tags: ["System"], summary: "Database and queue readiness check" }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      await Promise.all([probeDatabase(), probeQueue()]);
      return reply.send({ status: "ready", dependencies: { database: "ok", queue: "ok" } });
    } catch (error) {
      request.log.warn({ err: error }, "readiness dependency check failed");
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  app.register(async (candidate) => {
    async function findAssessment(rawToken: string) {
      const assessment = await prisma.assessment.findUnique({
        where: { launchTokenHash: tokenHash(rawToken) },
        include: {
          candidate: { select: { id: true, name: true, organizationId: true } },
          round: { include: { job: { include: { requirements: true } } } },
          evidence: true,
          integrityEvents: true
        }
      });
      if (!assessment || !assessment.launchExpiresAt || assessment.launchExpiresAt <= new Date()) {
        throw forbidden("launch_token_invalid", "This assessment link is invalid or has expired.", 401);
      }
      const configuration = resolveAssessmentConfiguration(assessment);
      if (configuration.round.type === "CODING_TEST") throw forbidden("code_sandbox_unavailable", "Coding assessments are disabled until an isolated execution provider is configured.", 503);
      return { ...assessment, round: { ...assessment.round, ...configuration.round, job: { ...assessment.round.job, ...configuration.job } } };
    }

    candidate.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });

    candidate.get<{ Params: { token: string } }>("/:token", {
      schema: { tags: ["Candidate session"], summary: "Resolve a secure candidate launch token" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      return {
        assessment: {
          id: assessment.id,
          type: assessment.round.type,
          status: assessment.status,
          candidateName: assessment.candidate.name,
          roundTitle: assessment.round.title,
          jobTitle: assessment.round.job.title,
          durationMinutes: assessment.round.durationMinutes,
          proctoringEnabled: assessment.round.proctoringEnabled,
          questions: assessment.round.questions,
          startedAt: assessment.startedAt,
          draft: assessment.status === "IN_PROGRESS" ? assessment.draft : null,
          draftRevision: assessment.draftRevision,
          draftSavedAt: assessment.draftSavedAt
        }
      };
    });

    candidate.post<{ Params: { token: string } }>("/:token/consent", {
      schema: { tags: ["Candidate session"], summary: "Record candidate consent" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      if (!["PENDING", "SCHEDULED"].includes(assessment.status)) throw forbidden("assessment_not_available", "This assessment is no longer accepting consent.", 409);
      if (assessment.consentedAt) return { id: assessment.id, status: assessment.status, consentedAt: assessment.consentedAt };
      const consentedAt = new Date();
      const changed = await prisma.assessment.updateMany({ where: { id: assessment.id, status: { in: ["PENDING", "SCHEDULED"] }, consentedAt: null, launchTokenHash: tokenHash(request.params.token), launchExpiresAt: { gt: consentedAt } }, data: { consentedAt, status: "SCHEDULED" } });
      if (changed.count !== 1) throw forbidden("assessment_not_available", "This assessment has changed or its link has expired.", 409);
      return { id: assessment.id, status: "SCHEDULED", consentedAt };
    });

    candidate.post<{ Params: { token: string } }>("/:token/start", {
      schema: { tags: ["Candidate session"], summary: "Start a consented assessment" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      if (!assessment.consentedAt) throw forbidden("consent_required", "Consent is required before this assessment can start.", 409);
      if (!canTransitionAssessment(assessment.status, "IN_PROGRESS")) throw forbidden("invalid_assessment_state", "This assessment cannot be started from its current state.", 409);
      const startedAt = new Date();
      const changed = await prisma.assessment.updateMany({ where: { id: assessment.id, status: assessment.status, consentedAt: { not: null }, launchTokenHash: tokenHash(request.params.token), launchExpiresAt: { gt: startedAt } }, data: { status: "IN_PROGRESS", startedAt } });
      if (changed.count !== 1) throw forbidden("invalid_assessment_state", "This assessment has already started, changed, or its link has expired.", 409);
      return { id: assessment.id, status: "IN_PROGRESS", startedAt };
    });

    candidate.patch<{ Params: { token: string } }>("/:token/draft", {
      schema: { tags: ["Candidate session"], summary: "Save an active assessment draft without overwriting newer edits" }
    }, async (request) => {
      const input = z.object({ revision: z.number().int().min(0).max(2_147_483_646), questionIndex: z.number().int().min(0).max(99), answers: z.record(z.string().min(1).max(100), z.string().max(10_000)) })
        .refine((value) => Object.keys(value.answers).length <= 100 && Object.values(value.answers).reduce((total, answer) => total + answer.length, 0) <= 50_000).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_draft", "Draft answers or revision are invalid or exceed the size limit.", 422);
      const assessment = await findAssessment(request.params.token);
      const draftSavedAt = new Date();
      const changed = await prisma.assessment.updateMany({ where: { id: assessment.id, status: "IN_PROGRESS", draftRevision: input.data.revision, launchTokenHash: tokenHash(request.params.token), launchExpiresAt: { gt: draftSavedAt } }, data: { draft: { answers: input.data.answers, questionIndex: input.data.questionIndex }, draftRevision: { increment: 1 }, draftSavedAt } });
      if (changed.count !== 1) throw forbidden("draft_conflict", "This session has changed, expired, or contains a newer draft. Reload the saved draft before continuing.", 409);
      return { revision: input.data.revision + 1, savedAt: draftSavedAt };
    });

    candidate.post<{ Params: { token: string } }>("/:token/integrity-events", {
      schema: { tags: ["Candidate session"], summary: "Append advisory browser integrity context" }
    }, async (request) => {
      const input = z.object({ type: z.enum(["FOCUS_CHANGE", "CAMERA_UNAVAILABLE", "RECONNECT"]), detail: z.record(z.string(), z.unknown()).default({}) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_integrity_event", "Integrity event is invalid.", 422);
      const assessment = await findAssessment(request.params.token);
      return prisma.$transaction(async (tx) => {
        const now = new Date();
        // A guarded update locks the assessment until the event commits, serializing submission.
        const active = await tx.assessment.updateMany({ where: { id: assessment.id, status: "IN_PROGRESS", launchTokenHash: tokenHash(request.params.token), launchExpiresAt: { gt: now } }, data: { updatedAt: now } });
        if (active.count !== 1) throw forbidden("assessment_not_in_progress", "Integrity context can only be recorded during an active, unexpired assessment.", 409);
        return tx.integrityEvent.create({ data: { assessmentId: assessment.id, type: input.data.type, severity: "INFO", detail: { ...input.data.detail, advisoryOnly: true } }, select: { id: true, type: true, occurredAt: true } });
      });
    });

    candidate.post<{ Params: { token: string } }>("/:token/submit", {
      schema: { tags: ["Candidate session"], summary: "Submit and evaluate an active assessment" }
    }, async (request, reply) => {
      const input = z.object({ response: z.string().trim().min(20).max(50_000), answers: z.record(z.string(), z.string()).optional(), draftRevision: z.number().int().min(0).max(2_147_483_647).optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_submission", "A meaningful response is required.", 422);
      if (process.env.NODE_ENV === "production") throw forbidden("assessment_provider_unavailable", "Assessment evaluation is disabled until a reviewed production provider is configured.", 503);
      const assessment = await findAssessment(request.params.token);
      if (assessment.status !== "IN_PROGRESS") throw forbidden("assessment_not_in_progress", "This assessment is not accepting a submission.", 409);

      const queued = process.env.ASSESSMENT_PROCESSING_MODE === "queue";
      const claimed = await prisma.assessment.updateMany({ where: { id: assessment.id, status: "IN_PROGRESS", draftRevision: input.data.draftRevision ?? 0, launchTokenHash: tokenHash(request.params.token), launchExpiresAt: { gt: new Date() } }, data: { status: "PROCESSING", submission: input.data.answers ?? { response: input.data.response }, submittedResponse: input.data.response, processingMode: queued ? "QUEUE" : "INLINE", draft: Prisma.DbNull } });
      if (claimed.count !== 1) throw forbidden("assessment_not_in_progress", "This assessment has already been submitted or changed.", 409);
      if (queued) {
        let deferred = false;
        await enqueuePersistedJobs([assessment.id], () => getAssessmentQueue().add("evaluate", { assessmentId: assessment.id }, {
            jobId: assessment.id,
            attempts: 3,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000
          }), (id, error) => { deferred = true; request.log.warn({ assessmentId: id, err: error }, "assessment queue submission deferred"); });
        return reply.status(202).send({ assessment: { id: assessment.id, status: "PROCESSING" }, processing: deferred ? "pending_queue" : "queued", advisoryOnly: true });
      }
      try {
        const result = await localEvaluator.evaluate({
          assessmentId: assessment.id,
          jobDescription: assessment.round.job.description,
          response: input.data.response,
          criteria: assessment.round.job.requirements.map((criterion) => ({ name: criterion.name, weight: criterion.weight }))
        });
        const completed = await prisma.$transaction((tx) => completeAssessment(tx, assessment.id, result));
        await queueWebhookDeliveries(completed.deliveries);
        return { assessment: completed.assessment, advisoryOnly: true };
      } catch (error) {
        await prisma.assessment.updateMany({ where: { id: assessment.id, status: "PROCESSING" }, data: { status: "FAILED" } });
        throw error;
      }
    });
  }, { prefix: "/candidate/assessments" });

  app.register(async (auth) => {
    auth.addHook("preHandler", async (request) => assertSameOriginForStateChanges(request, allowedBrowserOrigins));
    const loginSchema = z.object({ email: z.email(), password: z.string().min(8), mfaCode: z.string().trim().min(6).max(20).optional() });

    auth.post("/register", {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Register a verified workspace owner account" }
    }, async (request, reply) => {
      const input = z.object({ name: z.string().trim().min(2).max(120), email: z.email(), password: z.string().min(12).max(128), organizationName: z.string().trim().min(2).max(120), organizationType: z.enum(["EMPLOYER", "AGENCY", "UNIVERSITY"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_registration", "Enter valid account details and a password of at least 12 characters.", 422);
      const email = input.data.email.trim().toLowerCase();
      if (production && email.endsWith(".test")) throw forbidden("invalid_registration", "This email address cannot be used.", 422);
      if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
        return reply.status(202).send({ message: "If registration can be completed for this email, verification instructions will be sent." });
      }
      const passwordHash = await hash(input.data.password, 12);
      const rawToken = accountToken();
      const slug = registrationSlug(input.data.organizationName);
      let created: { id: string };
      try {
        created = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { email, name: input.data.name, passwordHash } });
          const organization = await tx.organization.create({ data: { name: input.data.organizationName, slug, type: input.data.organizationType } });
          await tx.membership.create({ data: { userId: user.id, organizationId: organization.id, role: "OWNER" } });
          await tx.accountToken.create({ data: { userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: tokenHash(rawToken), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) } });
          return { id: user.id };
        });
      } catch (error) {
        if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
          return reply.status(202).send({ message: "If registration can be completed for this email, verification instructions will be sent." });
        }
        throw error;
      }
      const link = accountLink("/login/verify-email", rawToken);
      try { await deliverAccountEmail({ to: email, subject: "Verify your Northstar email", link, action: "verify your email address" }); }
      catch (error) {
        request.log.error(error);
        await prisma.accountToken.updateMany({ where: { userId: created.id, purpose: "EMAIL_VERIFICATION", tokenHash: tokenHash(rawToken), consumedAt: null }, data: { consumedAt: new Date() } });
      }
      return reply.status(202).send({ message: "Your workspace is ready. Verify your email before signing in.", ...(!production ? { developmentActionUrl: link } : {}) });
    });

    auth.post("/password-reset/request", {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Request a password reset email" }
    }, async (request, reply) => {
      const input = z.object({ email: z.email() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_email", "Enter a valid email address.", 422);
      const email = input.data.email.trim().toLowerCase();
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
      let previewUrl: string | undefined;
      if (user?.passwordHash) {
        const rawToken = accountToken();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1_000);
        await prisma.$transaction([
          prisma.accountToken.updateMany({ where: { userId: user.id, purpose: "PASSWORD_RESET", consumedAt: null }, data: { consumedAt: new Date() } }),
          prisma.accountToken.create({ data: { userId: user.id, purpose: "PASSWORD_RESET", tokenHash: tokenHash(rawToken), expiresAt } })
        ]);
        const link = accountLink("/login/reset-password", rawToken);
        try { await deliverAccountEmail({ to: email, subject: "Reset your Northstar password", link, action: "reset your password" }); }
        catch (error) {
          request.log.error(error);
          await prisma.accountToken.updateMany({ where: { userId: user.id, purpose: "PASSWORD_RESET", tokenHash: tokenHash(rawToken), consumedAt: null }, data: { consumedAt: new Date() } });
        }
        if (!production) previewUrl = link;
      }
      return reply.send({ message: "If an account exists for that email, password reset instructions have been sent.", ...(previewUrl ? { developmentActionUrl: previewUrl } : {}) });
    });

    auth.post("/password-reset/confirm", {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Set a new password with a reset token" }
    }, async (request, reply) => {
      const input = z.object({ token: z.string().min(32).max(200), password: z.string().min(12).max(128) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_password_reset", "Use a valid reset link and a password of at least 12 characters.", 422);
      const now = new Date();
      const accountTokenRecord = await prisma.accountToken.findFirst({ where: { tokenHash: tokenHash(input.data.token), purpose: "PASSWORD_RESET", consumedAt: null, expiresAt: { gt: now } }, select: { id: true, userId: true } });
      if (!accountTokenRecord) throw forbidden("password_reset_invalid", "This password reset link is invalid or has expired.", 400);
      const passwordHash = await hash(input.data.password, 12);
      await prisma.$transaction(async (tx) => {
        const consumed = await tx.accountToken.updateMany({ where: { id: accountTokenRecord.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
        if (consumed.count !== 1) throw forbidden("password_reset_invalid", "This password reset link is invalid or has expired.", 400);
        await tx.user.update({ where: { id: accountTokenRecord.userId }, data: { passwordHash } });
        await tx.session.updateMany({ where: { userId: accountTokenRecord.userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.accountToken.updateMany({ where: { userId: accountTokenRecord.userId, purpose: "PASSWORD_RESET", consumedAt: null }, data: { consumedAt: now } });
      });
      return reply.send({ message: "Your password has been updated. You can now sign in." });
    });

    auth.post("/verification/request", {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Request a fresh email verification link" }
    }, async (request, reply) => {
      const input = z.object({ email: z.email() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_email", "Enter a valid email address.", 422);
      const email = input.data.email.trim().toLowerCase();
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
      let previewUrl: string | undefined;
      if (user && !user.emailVerifiedAt) {
        const rawToken = accountToken();
        await prisma.$transaction([
          prisma.accountToken.updateMany({ where: { userId: user.id, purpose: "EMAIL_VERIFICATION", consumedAt: null }, data: { consumedAt: new Date() } }),
          prisma.accountToken.create({ data: { userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: tokenHash(rawToken), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) } })
        ]);
        const link = accountLink("/login/verify-email", rawToken);
        try { await deliverAccountEmail({ to: email, subject: "Verify your Northstar email", link, action: "verify your email address" }); }
        catch (error) {
          request.log.error(error);
          await prisma.accountToken.updateMany({ where: { userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: tokenHash(rawToken), consumedAt: null }, data: { consumedAt: new Date() } });
        }
        if (!production) previewUrl = link;
      }
      return reply.send({ message: "If this account needs verification, instructions have been sent.", ...(previewUrl ? { developmentActionUrl: previewUrl } : {}) });
    });

    auth.post("/verification/confirm", {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Verify an email address with a token" }
    }, async (request, reply) => {
      const input = z.object({ token: z.string().min(32).max(200) }).safeParse(request.body);
      if (!input.success) throw forbidden("verification_invalid", "This verification link is invalid or has expired.", 400);
      const now = new Date();
      const record = await prisma.accountToken.findFirst({ where: { tokenHash: tokenHash(input.data.token), purpose: "EMAIL_VERIFICATION", consumedAt: null, expiresAt: { gt: now } }, select: { id: true, userId: true } });
      if (!record) throw forbidden("verification_invalid", "This verification link is invalid or has expired.", 400);
      await prisma.$transaction(async (tx) => {
        const consumed = await tx.accountToken.updateMany({ where: { id: record.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
        if (consumed.count !== 1) throw forbidden("verification_invalid", "This verification link is invalid or has expired.", 400);
        await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: now } });
      });
      return reply.send({ message: "Email verified. You can now sign in." });
    });

    auth.get("/invitations/:token", {
      schema: { tags: ["Authentication"], summary: "Read a workspace invitation" }
    }, async (request, reply) => {
      const params = z.object({ token: z.string().min(32).max(200) }).safeParse(request.params);
      if (!params.success) throw forbidden("invitation_invalid", "This invitation is invalid or has expired.", 400);
      const invitation = await prisma.workspaceInvitation.findFirst({ where: { tokenHash: tokenHash(params.data.token), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, include: { organization: { select: { name: true } } } });
      if (!invitation) throw forbidden("invitation_invalid", "This invitation is invalid or has expired.", 400);
      const user = await prisma.user.findUnique({ where: { email: invitation.email }, select: { passwordHash: true } });
      return reply.send({ email: invitation.email, organizationName: invitation.organization.name, role: invitation.role, requiresPassword: !user?.passwordHash });
    });

    auth.post("/invitations/:token/accept", {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: { tags: ["Authentication"], summary: "Accept a workspace invitation" }
    }, async (request, reply) => {
      const params = z.object({ token: z.string().min(32).max(200) }).safeParse(request.params);
      const input = z.object({ name: z.string().trim().min(2).max(120).optional(), password: z.string().min(12).max(128).optional() }).safeParse(request.body);
      if (!params.success || !input.success) throw forbidden("invitation_invalid", "This invitation or account information is invalid.", 400);
      const now = new Date();
      const invitation = await prisma.workspaceInvitation.findFirst({ where: { tokenHash: tokenHash(params.data.token), acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } });
      if (!invitation) throw forbidden("invitation_invalid", "This invitation is invalid or has expired.", 400);
      const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
      if ((!existing || !existing.passwordHash) && (!input.data.name || !input.data.password)) {
        throw forbidden("account_setup_required", "Enter your name and a password of at least 12 characters to activate this account.", 422);
      }
      if (existing?.passwordHash && input.data.password) throw forbidden("account_exists", "This email already has an account. Sign in before joining another workspace.", 409);
      const passwordHash = input.data.password ? await hash(input.data.password, 12) : undefined;
      await prisma.$transaction(async (tx) => {
        const accepted = await tx.workspaceInvitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } });
        if (accepted.count !== 1) throw forbidden("invitation_invalid", "This invitation is invalid or has expired.", 400);
        const user = existing
          ? await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: existing.emailVerifiedAt ?? now, ...(passwordHash && input.data.name ? { passwordHash, name: input.data.name } : {}) } })
          : await tx.user.create({ data: { email: invitation.email, name: input.data.name as string, passwordHash: passwordHash as string, emailVerifiedAt: now } });
        await tx.membership.upsert({ where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } }, create: { userId: user.id, organizationId: invitation.organizationId, role: invitation.role }, update: {} });
        await tx.auditEvent.create({ data: { organizationId: invitation.organizationId, actorId: user.id, action: "workspace.invitation.accepted", entityType: "workspace_invitation", entityId: invitation.id, metadata: { invitedById: invitation.invitedById, email: invitation.email, role: invitation.role } } });
      });
      return reply.send({ message: "Invitation accepted. You can now sign in." });
    });

    auth.get("/mfa/status", { schema: { tags: ["Authentication"], summary: "Read MFA status for the signed-in account" } }, async (request) => {
      const userId = await authenticatedUserId(request);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabledAt: true, mfaRecoveryCodes: { where: { usedAt: null }, select: { id: true } } } });
      return { enabled: Boolean(user.mfaEnabledAt), recoveryCodesRemaining: user.mfaRecoveryCodes.length };
    });

    auth.post("/mfa/enroll", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } }, schema: { tags: ["Authentication"], summary: "Begin TOTP MFA enrollment" } }, async (request) => {
      const userId = await authenticatedUserId(request);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, mfaEnabledAt: true } });
      if (user.mfaEnabledAt) throw forbidden("mfa_already_enabled", "MFA is already enabled. Disable it before enrolling again.", 409);
      const secret = createTotpSecret();
      await prisma.user.update({ where: { id: userId }, data: { mfaSecretEncrypted: encryptTotpSecret(secret) } });
      return { secret, otpauthUri: totpUri(secret, user.email), message: "Add this account to your authenticator app, then confirm with its six-digit code." };
    });

    auth.post("/mfa/confirm", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } }, schema: { tags: ["Authentication"], summary: "Confirm MFA enrollment and issue recovery codes" } }, async (request) => {
      const userId = await authenticatedUserId(request);
      const input = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_mfa_code", "Enter the six-digit code from your authenticator app.", 422);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecretEncrypted: true, mfaEnabledAt: true } });
      if (user.mfaEnabledAt || !user.mfaSecretEncrypted) throw forbidden("mfa_enrollment_missing", "Start MFA enrollment before confirming it.", 409);
      if (!verifyTotp(decryptTotpSecret(user.mfaSecretEncrypted), input.data.code)) throw forbidden("invalid_mfa_code", "That authenticator code is invalid or expired.", 400);
      const codes = createRecoveryCodes();
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
        await tx.mfaRecoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: tokenHash(code) })) });
      });
      return { message: "MFA is enabled. Store these recovery codes somewhere safe; they will only be shown once.", recoveryCodes: codes };
    });

    auth.post("/mfa/disable", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } }, schema: { tags: ["Authentication"], summary: "Disable MFA after password and second-factor verification" } }, async (request) => {
      const userId = await authenticatedUserId(request);
      const input = z.object({ password: z.string().min(8), code: z.string().trim().min(6).max(20) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_mfa_disable", "Enter your password and authenticator or recovery code.", 422);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, mfaSecretEncrypted: true, mfaEnabledAt: true } });
      if (!user.mfaEnabledAt || !user.mfaSecretEncrypted || !user.passwordHash || !(await compare(input.data.password, user.passwordHash))) throw forbidden("invalid_mfa_disable", "The password or second-factor code is incorrect.", 401);
      const secret = decryptTotpSecret(user.mfaSecretEncrypted);
      let factorIsValid = /^\d{6}$/.test(input.data.code) && verifyTotp(secret, input.data.code);
      if (!factorIsValid) {
        const codeHash = tokenHash(input.data.code.toUpperCase());
        const consumed = await prisma.mfaRecoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: new Date() } });
        factorIsValid = consumed.count === 1;
      }
      if (!factorIsValid) throw forbidden("invalid_mfa_disable", "The password or second-factor code is incorrect.", 401);
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { mfaSecretEncrypted: null, mfaEnabledAt: null } }),
        prisma.mfaRecoveryCode.deleteMany({ where: { userId } })
      ]);
      return { message: "MFA has been disabled." };
    });

    auth.post("/login", {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["Authentication"], summary: "Create a secure browser session" }
    }, async (request, reply) => {
      const input = loginSchema.safeParse(request.body);
      if (!input.success) throw forbidden("invalid_credentials", "Email or password is incorrect.", 401);
      const user = await prisma.user.findUnique({
        where: { email: input.data.email.toLowerCase() },
        include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true, type: true } } } } }
      });
      if (production && input.data.email.toLowerCase().endsWith(".test")) throw forbidden("invalid_credentials", "Email or password is incorrect.", 401);
      if (!user?.passwordHash || !(await compare(input.data.password, user.passwordHash))) {
        throw forbidden("invalid_credentials", "Email or password is incorrect.", 401);
      }
      if (!user.emailVerifiedAt) throw forbidden("email_not_verified", "Verify your email address before signing in.", 403);
      if (user.mfaEnabledAt && user.mfaSecretEncrypted) {
        if (!input.data.mfaCode) return reply.status(202).send({ mfaRequired: true, message: "Enter your authenticator or recovery code to finish signing in." });
        let factorIsValid = /^\d{6}$/.test(input.data.mfaCode) && verifyTotp(decryptTotpSecret(user.mfaSecretEncrypted), input.data.mfaCode);
        if (!factorIsValid) {
          const consumed = await prisma.mfaRecoveryCode.updateMany({ where: { userId: user.id, codeHash: tokenHash(input.data.mfaCode.toUpperCase()), usedAt: null }, data: { usedAt: new Date() } });
          factorIsValid = consumed.count === 1;
        }
        if (!factorIsValid) throw forbidden("invalid_mfa_code", "That authenticator or recovery code is invalid.", 401);
      }
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1_000);
      const token = await createSessionToken(user.id, sessionId, expiresAt);
      await prisma.session.create({ data: { id: sessionId, userId: user.id, expiresAt } });
      reply.setCookie("northstar_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 12
      });
      return {
        user: { id: user.id, name: user.name, email: user.email },
        organizations: user.memberships.map((membership) => ({ ...membership.organization, role: membership.role }))
      };
    });

    auth.post("/logout", {
      schema: { tags: ["Authentication"], summary: "End the browser session" }
    }, async (request, reply) => {
      const token = request.cookies.northstar_session;
      const identity = token ? await readSessionToken(token) : null;
      if (identity) await prisma.session.updateMany({ where: { id: identity.sessionId, userId: identity.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      reply.clearCookie("northstar_session", { path: "/" });
      return reply.status(204).send();
    });

    auth.post("/logout-all", {
      schema: { tags: ["Authentication"], summary: "Revoke all browser sessions for the current user" }
    }, async (request, reply) => {
      const token = request.cookies.northstar_session;
      const identity = token ? await readSessionToken(token) : null;
      if (!identity) throw forbidden("session_required", "Sign in to continue.", 401);
      await prisma.session.updateMany({ where: { userId: identity.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      reply.clearCookie("northstar_session", { path: "/" });
      return reply.status(204).send();
    });

    auth.get("/session", {
      schema: { tags: ["Authentication"], summary: "Read the active browser session" }
    }, async (request) => {
      const token = request.cookies.northstar_session;
      const identity = token ? await readSessionToken(token) : null;
      if (!identity) throw forbidden("session_required", "Sign in to continue.", 401);
      const activeSession = await prisma.session.findFirst({ where: { id: identity.sessionId, userId: identity.userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!activeSession) throw forbidden("session_required", "Sign in to continue.", 401);
      const user = await prisma.user.findUnique({
        where: { id: identity.userId },
        include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true, type: true } } } } }
      });
      if (!user) throw forbidden("session_required", "Sign in to continue.", 401);
      return { user: { id: user.id, name: user.name, email: user.email }, organizations: user.memberships.map((membership) => ({ ...membership.organization, role: membership.role })) };
    });
  }, { prefix: "/v1/auth" });

  app.register(async (v1) => {
    v1.addHook("preHandler", async (request) => {
      assertSameOriginForStateChanges(request, allowedBrowserOrigins);
      const token = request.cookies.northstar_session;
      const identity = token ? await readSessionToken(token) : null;
      if (!identity) throw forbidden("session_required", "Sign in to continue.", 401);
      const activeSession = await prisma.session.findFirst({ where: { id: identity.sessionId, userId: identity.userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!activeSession) throw forbidden("session_required", "Sign in to continue.", 401);
      request.currentUserId = identity.userId;
      request.currentSessionId = identity.sessionId;
      request.organizationId = requestOrganization(request);
      const membership = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: identity.userId, organizationId: request.organizationId } },
        select: { role: true }
      });
      if (!membership) {
        const error = new Error("Organization not found.");
        Object.assign(error, { statusCode: 404, code: "organization_not_found" });
        throw error;
      }
      request.membershipRole = membership.role as Role;
      const routePath = request.url.split("?")[0] ?? request.url;
      if (routePath.startsWith("/v1/placements") || routePath.startsWith("/v1/student")) {
        const organization = await prisma.organization.findUnique({ where: { id: request.organizationId }, select: { type: true } });
        if (organization?.type !== "UNIVERSITY") throw forbidden("university_workspace_required", "Placement routes are only available in university workspaces.", 403);
      }
    });

    await registerNovaRoutes(v1, options.nova);

    v1.get("/invitations", {
      schema: { tags: ["Workspace settings"], summary: "List pending workspace invitations" }
    }, async (request) => {
      if (!(["OWNER", "ADMIN"] as Role[]).includes(request.membershipRole)) requirePermission(request, "member.manage");
      return prisma.workspaceInvitation.findMany({
        where: { organizationId: request.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100
      });
    });

    v1.post("/invitations", {
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
      schema: { tags: ["Workspace settings"], summary: "Invite a member to the active workspace" }
    }, async (request, reply) => {
      if (!(["OWNER", "ADMIN"] as Role[]).includes(request.membershipRole)) requirePermission(request, "member.manage");
      const input = z.object({ email: z.email(), role: z.enum(["ADMIN", "HIRING_MANAGER", "RECRUITER", "INTERVIEWER", "PLACEMENT_COORDINATOR", "VIEWER", "STUDENT", "CANDIDATE"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_invitation", "Choose a valid email and workspace role.", 422);
      const email = input.data.email.trim().toLowerCase();
      if (request.membershipRole === "ADMIN" && input.data.role === "ADMIN") throw forbidden("permission_denied", "Only an owner can invite another administrator.");
      const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existingUser && await prisma.membership.findUnique({ where: { userId_organizationId: { userId: existingUser.id, organizationId: request.organizationId } } })) {
        throw forbidden("member_exists", "This person is already a workspace member.", 409);
      }
      const organization = await prisma.organization.findUniqueOrThrow({ where: { id: request.organizationId }, select: { name: true } });
      const rawToken = accountToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
      const invitation = await prisma.$transaction(async (tx) => {
        await tx.workspaceInvitation.updateMany({ where: { organizationId: request.organizationId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
        const created = await tx.workspaceInvitation.create({ data: { organizationId: request.organizationId, invitedById: request.currentUserId, email, role: input.data.role, tokenHash: tokenHash(rawToken), expiresAt } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "workspace.invitation.created", entityType: "workspace_invitation", entityId: created.id, metadata: { email, role: input.data.role, expiresAt: expiresAt.toISOString() } } });
        return created;
      });
      const link = accountLink("/invite/accept", rawToken);
      try {
        await deliverAccountEmail({ to: email, subject: `Join ${organization.name} on Northstar`, link, action: `accept your invitation to ${organization.name}` });
      } catch (error) {
        await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
        throw error;
      }
      return reply.status(201).send({ id: invitation.id, email, role: invitation.role, expiresAt, ...(production ? {} : { developmentActionUrl: link }) });
    });

    v1.delete<{ Params: { invitationId: string } }>("/invitations/:invitationId", {
      schema: { tags: ["Workspace settings"], summary: "Revoke a pending workspace invitation" }
    }, async (request, reply) => {
      if (!(["OWNER", "ADMIN"] as Role[]).includes(request.membershipRole)) requirePermission(request, "member.manage");
      const invitation = await prisma.workspaceInvitation.findFirst({ where: { id: request.params.invitationId, organizationId: request.organizationId, acceptedAt: null, revokedAt: null }, select: { id: true, email: true, role: true } });
      if (!invitation) throw forbidden("invitation_not_found", "Pending invitation was not found.", 404);
      await prisma.$transaction([
        prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } }),
        prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "workspace.invitation.revoked", entityType: "workspace_invitation", entityId: invitation.id, metadata: { email: invitation.email, role: invitation.role } } })
      ]);
      return reply.status(204).send();
    });

    v1.get("/dashboard", {
      schema: { tags: ["Workspace"], summary: "Workspace summary" }
    }, async (request) => {
      const [jobs, candidates, assessments, clients] = await Promise.all([
        prisma.job.count({ where: { organizationId: request.organizationId } }),
        prisma.candidate.count({ where: { organizationId: request.organizationId } }),
        prisma.assessment.count({ where: { candidate: { organizationId: request.organizationId } } }),
        prisma.client.count({ where: { organizationId: request.organizationId } })
      ]);
      return { object: "workspace_summary", jobs, candidates, assessments, clients };
    });

    v1.get("/workspace", {
      schema: { tags: ["Workspace"], summary: "Active organization and membership details" }
    }, async (request) => {
      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: request.organizationId },
        select: { id: true, name: true, slug: true, type: true, logoUrl: true, primaryColor: true, modules: true, creditBalance: true }
      });
      return { organization, membership: { role: request.membershipRole } };
    });

    v1.get("/api-keys", { schema: { tags: ["Developer platform"], summary: "List active and revoked organization API keys" } }, async (request) => {
      requirePermission(request, "settings.manage");
      return prisma.apiKey.findMany({ where: { organizationId: request.organizationId }, select: { id: true, name: true, prefix: true, environment: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } });
    });

    v1.post("/api-keys", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } }, schema: { tags: ["Developer platform"], summary: "Create a scoped API key; the secret is returned once" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const allowedScopes = ["jobs:read", "candidates:read", "candidates:write"] as const;
      const input = z.object({ name: z.string().trim().min(2).max(80), environment: z.enum(["test", "live"]).default("test"), scopes: z.array(z.enum(allowedScopes)).min(1).max(3) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_api_key", "Provide a name and at least one supported scope.", 422);
      const secret = `nsk_${input.data.environment}_${randomBytes(32).toString("base64url")}`;
      const prefix = secret.slice(0, 18);
      const key = await prisma.apiKey.create({ data: { organizationId: request.organizationId, name: input.data.name, prefix, keyHash: tokenHash(secret), environment: input.data.environment, scopes: input.data.scopes } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "api_key.created", entityType: "api_key", entityId: key.id, metadata: { name: key.name, environment: key.environment, scopes: key.scopes } } });
      return reply.status(201).send({ id: key.id, name: key.name, prefix: key.prefix, environment: key.environment, scopes: key.scopes, secret, createdAt: key.createdAt });
    });

    v1.delete<{ Params: { keyId: string } }>("/api-keys/:keyId", { schema: { tags: ["Developer platform"], summary: "Revoke an API key" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const key = await prisma.apiKey.findFirst({ where: { id: request.params.keyId, organizationId: request.organizationId, revokedAt: null }, select: { id: true, name: true } });
      if (!key) throw forbidden("api_key_not_found", "Active API key was not found.", 404);
      await prisma.$transaction([
        prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } }),
        prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "api_key.revoked", entityType: "api_key", entityId: key.id, metadata: { name: key.name } } })
      ]);
      return reply.status(204).send();
    });

    v1.get("/webhooks", { schema: { tags: ["Developer platform"], summary: "List webhook endpoints" } }, async (request) => {
      requirePermission(request, "settings.manage");
      return prisma.webhookEndpoint.findMany({ where: { organizationId: request.organizationId }, select: { id: true, url: true, events: true, active: true, createdAt: true, updatedAt: true, _count: { select: { deliveries: true } } }, orderBy: { createdAt: "desc" } });
    });

    v1.post("/webhooks", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } }, schema: { tags: ["Developer platform"], summary: "Create a signed webhook endpoint" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const eventTypes = ["candidate.created", "candidate.updated", "candidate_job.created", "candidate_job.stage_changed", "assessment.completed", "meeting.created", "placement.application.created"] as const;
      const input = z.object({ url: z.url(), events: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_webhook", "Provide a valid HTTPS URL and supported event subscriptions.", 422);
      try { await validateWebhookDestination(input.data.url); }
      catch (error) { throw forbidden("unsafe_webhook_destination", error instanceof Error ? error.message : "Webhook URL is not allowed.", 422); }
      const secret = `whsec_${randomBytes(32).toString("base64url")}`;
      const endpoint = await prisma.webhookEndpoint.create({ data: { organizationId: request.organizationId, url: input.data.url, events: [...new Set(input.data.events)], secretHash: tokenHash(secret), secretEncrypted: encryptWebhookSecret(secret) } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "webhook.created", entityType: "webhook_endpoint", entityId: endpoint.id, metadata: { url: endpoint.url, events: endpoint.events } } });
      return reply.status(201).send({ id: endpoint.id, url: endpoint.url, events: endpoint.events, active: endpoint.active, secret, createdAt: endpoint.createdAt });
    });

    v1.delete<{ Params: { endpointId: string } }>("/webhooks/:endpointId", { schema: { tags: ["Developer platform"], summary: "Disable a webhook endpoint" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: request.params.endpointId, organizationId: request.organizationId, active: true }, select: { id: true } });
      if (!endpoint) throw forbidden("webhook_not_found", "Active webhook endpoint was not found.", 404);
      await prisma.$transaction([
        prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { active: false } }),
        prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "webhook.disabled", entityType: "webhook_endpoint", entityId: endpoint.id } })
      ]);
      return reply.status(204).send();
    });

    v1.get<{ Params: { endpointId: string } }>("/webhooks/:endpointId/deliveries", { schema: { tags: ["Developer platform"], summary: "List recent webhook deliveries" } }, async (request) => {
      requirePermission(request, "settings.manage");
      const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: request.params.endpointId, organizationId: request.organizationId }, select: { id: true } });
      if (!endpoint) throw forbidden("webhook_not_found", "Webhook endpoint was not found.", 404);
      return prisma.webhookDelivery.findMany({ where: { endpointId: endpoint.id }, select: { id: true, eventId: true, eventType: true, status: true, attemptCount: true, lastStatusCode: true, lastError: true, deliveredAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 });
    });

    v1.post<{ Params: { deliveryId: string } }>("/webhooks/deliveries/:deliveryId/replay", { schema: { tags: ["Developer platform"], summary: "Replay a failed webhook delivery" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: request.params.deliveryId, endpoint: { organizationId: request.organizationId, active: true } }, select: { id: true, status: true } });
      if (!delivery) throw forbidden("webhook_delivery_not_found", "Failed delivery was not found for an active endpoint.", 404);
      if (delivery.status !== "FAILED") throw forbidden("webhook_delivery_not_failed", "Only failed deliveries can be replayed.", 409);
      await prisma.$transaction(async (tx) => {
        const changed = await tx.webhookDelivery.updateMany({ where: { id: delivery.id, status: "FAILED" }, data: { status: "PENDING", attemptCount: 0, nextAttemptAt: new Date(), lastStatusCode: null, lastError: null, processingToken: null, processingExpiresAt: null, deliveredAt: null } });
        if (changed.count !== 1) throw forbidden("webhook_delivery_not_failed", "Delivery was already replayed or changed.", 409);
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "webhook.delivery.replayed", entityType: "webhook_delivery", entityId: delivery.id } });
      });
      await queueWebhookDeliveries([delivery.id]);
      return reply.status(202).send({ id: delivery.id, status: "PENDING" });
    });

    v1.get("/clients", {
      schema: { tags: ["Clients"], summary: "List tenant-owned client accounts and commercial terms" }
    }, async (request) => {
      requirePermission(request, "job.read");
      const data = await prisma.client.findMany({
        where: { organizationId: request.organizationId },
        include: { _count: { select: { jobs: true } } },
        orderBy: { createdAt: "desc" }
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.post("/clients", {
      schema: { tags: ["Clients"], summary: "Create a client and persist commercial terms" }
    }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const input = z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(1000).optional(),
        industry: z.string().trim().max(80).optional(),
        status: z.enum(["PROSPECT", "BRIEFING", "ACTIVE", "PAUSED"]).default("PROSPECT"),
        feeType: z.enum(["PERCENTAGE", "FLAT"]).optional(),
        feeAmount: z.number().nonnegative().max(100_000_000).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
        guaranteeDays: z.number().int().min(0).max(730).optional(),
        billingEmail: z.email().optional()
      }).refine((value) => (value.feeType === undefined) === (value.feeAmount === undefined), { message: "Fee type and amount must be provided together." }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_client", "Client details or commercial terms are invalid.", 422);
      const slugBase = input.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "client";
      const slug = `${slugBase}-${randomBytes(3).toString("hex")}`;
      const client = await prisma.client.create({
        data: {
          organizationId: request.organizationId,
          slug,
          name: input.data.name,
          ...(input.data.description === undefined ? {} : { description: input.data.description }),
          ...(input.data.industry === undefined ? {} : { industry: input.data.industry }),
          status: input.data.status,
          ...(input.data.feeType === undefined ? {} : { feeType: input.data.feeType }),
          ...(input.data.feeAmount === undefined ? {} : { feeAmount: input.data.feeAmount }),
          currency: input.data.currency,
          ...(input.data.guaranteeDays === undefined ? {} : { guaranteeDays: input.data.guaranteeDays }),
          ...(input.data.billingEmail === undefined ? {} : { billingEmail: input.data.billingEmail })
        }
      });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "client.created", entityType: "client", entityId: client.id } });
      return reply.status(201).send(client);
    });

    v1.patch<{ Params: { clientId: string } }>("/clients/:clientId", {
      schema: { tags: ["Clients"], summary: "Update client status or commercial terms" }
    }, async (request) => {
      requirePermission(request, "settings.manage");
      const input = z.object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        industry: z.string().trim().max(80).nullable().optional(),
        status: z.enum(["PROSPECT", "BRIEFING", "ACTIVE", "PAUSED"]).optional(),
        feeType: z.enum(["PERCENTAGE", "FLAT"]).nullable().optional(),
        feeAmount: z.number().nonnegative().max(100_000_000).nullable().optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
        guaranteeDays: z.number().int().min(0).max(730).nullable().optional(),
        billingEmail: z.email().nullable().optional()
      }).refine((value) => Object.keys(value).length > 0)
        .refine((value) => (value.feeType === undefined) === (value.feeAmount === undefined), { message: "Fee type and amount must be updated together." })
        .safeParse(request.body);
      if (!input.success) throw forbidden("invalid_client", "Provide at least one valid client field.", 422);
      const existing = await prisma.client.findFirst({ where: { id: request.params.clientId, organizationId: request.organizationId }, select: { id: true } });
      if (!existing) throw forbidden("client_not_found", "Client was not found in this organization.", 404);
      const client = await prisma.client.update({ where: { id: existing.id }, data: {
        ...(input.data.name === undefined ? {} : { name: input.data.name }),
        ...(input.data.description === undefined ? {} : { description: input.data.description }),
        ...(input.data.industry === undefined ? {} : { industry: input.data.industry }),
        ...(input.data.status === undefined ? {} : { status: input.data.status }),
        ...(input.data.feeType === undefined ? {} : { feeType: input.data.feeType }),
        ...(input.data.feeAmount === undefined ? {} : { feeAmount: input.data.feeAmount }),
        ...(input.data.currency === undefined ? {} : { currency: input.data.currency }),
        ...(input.data.guaranteeDays === undefined ? {} : { guaranteeDays: input.data.guaranteeDays }),
        ...(input.data.billingEmail === undefined ? {} : { billingEmail: input.data.billingEmail })
      } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "client.updated", entityType: "client", entityId: client.id, metadata: { fields: Object.keys(input.data) } } });
      return client;
    });

    v1.get("/staffing/placements", { schema: { tags: ["Staffing"], summary: "List attributed starts, draft invoices, and guarantees" } }, async (request) => {
      requirePermission(request, "settings.manage");
      return prisma.staffingPlacement.findMany({
        where: { organizationId: request.organizationId },
        include: { client: { select: { id: true, name: true, billingEmail: true } }, job: { select: { id: true, title: true } }, candidateJob: { include: { candidate: { select: { id: true, name: true, email: true } } } }, invoice: true },
        orderBy: { startDate: "desc" }
      });
    });

    v1.post("/staffing/placements", { schema: { tags: ["Staffing"], summary: "Attribute a candidate start and prepare a draft fee invoice" } }, async (request, reply) => {
      requirePermission(request, "settings.manage");
      const input = z.object({ candidateJobId: z.string().min(1), startDate: z.iso.datetime(), salary: z.number().positive().max(1_000_000_000), salaryCurrency: z.string().regex(/^[A-Z]{3}$/) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_staffing_placement", "Provide a role attribution, valid start date, salary, and ISO currency.", 422);
      const assignment = await prisma.candidateJob.findFirst({
        where: { id: input.data.candidateJobId, job: { organizationId: request.organizationId } },
        include: { candidate: { select: { id: true, name: true, organizationId: true } }, job: { include: { client: true } } }
      });
      if (!assignment || !assignment.job.client || assignment.candidate.organizationId !== request.organizationId || assignment.job.client.organizationId !== request.organizationId) throw forbidden("staffing_placement_target_not_found", "The candidate's role or linked client was not found in this workspace.", 404);
      const client = assignment.job.client;
      if (!client.feeType || client.feeAmount === null) throw forbidden("client_fee_terms_missing", "Set client fee terms before recording a placement start.", 409);
      const feeRate = assignment.job.feeOverride === null ? Number(client.feeAmount) : Number(assignment.job.feeOverride);
      const feeType = client.feeType;
      const feeAmount = feeType === "PERCENTAGE" ? Math.round(input.data.salary * feeRate) / 100 : feeRate;
      const feeCurrency = feeType === "PERCENTAGE" ? input.data.salaryCurrency : client.currency;
      const guaranteeDays = assignment.job.guaranteeOverride ?? client.guaranteeDays;
      const startDate = new Date(input.data.startDate);
      const guaranteeUntil = guaranteeDays === null ? null : new Date(startDate.getTime() + guaranteeDays * 86_400_000);
      try {
        const placement = await prisma.$transaction(async (tx) => {
          const created = await tx.staffingPlacement.create({ data: {
            organizationId: request.organizationId,
            clientId: client.id,
            jobId: assignment.jobId,
            candidateJobId: assignment.id,
            startDate,
            salary: input.data.salary,
            salaryCurrency: input.data.salaryCurrency,
            feeAmount,
            feeCurrency,
            feeType,
            feeRate,
            guaranteeUntil,
            invoice: { create: { organizationId: request.organizationId, invoiceNumber: `NS-${startDate.getUTCFullYear()}-${randomUUID().slice(0, 10).toUpperCase()}`, amount: feeAmount, currency: feeCurrency } }
          }, include: { invoice: true, client: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, candidateJob: { include: { candidate: { select: { id: true, name: true } } } } } });
          await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "staffing.placement.created", entityType: "staffing_placement", entityId: created.id, metadata: { clientId: client.id, candidateJobId: assignment.id, startDate: startDate.toISOString(), feeAmount, feeCurrency, invoiceId: created.invoice?.id } } });
          return created;
        });
        return reply.status(201).send(placement);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") throw forbidden("staffing_placement_exists", "A start has already been recorded for this candidate and role.", 409);
        throw error;
      }
    });

    v1.patch<{ Params: { placementId: string } }>("/staffing/placements/:placementId/guarantee", { schema: { tags: ["Staffing"], summary: "Resolve or reopen a placement guarantee" } }, async (request) => {
      requirePermission(request, "settings.manage");
      const input = z.object({ resolved: z.boolean() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_guarantee_update", "Set resolved to true or false.", 422);
      const placement = await prisma.staffingPlacement.findFirst({ where: { id: request.params.placementId, organizationId: request.organizationId }, select: { id: true, guaranteeUntil: true, guaranteeResolvedAt: true } });
      if (!placement) throw forbidden("staffing_placement_not_found", "Placement was not found in this workspace.", 404);
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.staffingPlacement.update({ where: { id: placement.id }, data: { guaranteeResolvedAt: input.data.resolved ? new Date() : null } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "staffing.guarantee.updated", entityType: "staffing_placement", entityId: changed.id, metadata: { resolved: input.data.resolved, previousResolvedAt: placement.guaranteeResolvedAt?.toISOString() ?? null, guaranteeUntil: placement.guaranteeUntil?.toISOString() ?? null } } });
        return changed;
      });
      return updated;
    });

    v1.patch<{ Params: { invoiceId: string } }>("/staffing/invoices/:invoiceId", { schema: { tags: ["Staffing"], summary: "Issue, reconcile, or void an internal placement invoice" } }, async (request) => {
      requirePermission(request, "settings.manage");
      const input = z.object({ status: z.enum(["ISSUED", "PAID", "VOID"]), dueAt: z.iso.datetime().optional(), paidAt: z.iso.datetime().optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_invoice_update", "Invoice status or dates are invalid.", 422);
      const invoice = await prisma.staffingInvoice.findFirst({ where: { id: request.params.invoiceId, organizationId: request.organizationId } });
      if (!invoice) throw forbidden("staffing_invoice_not_found", "Invoice was not found in this workspace.", 404);
      const allowed: Record<string, readonly string[]> = { DRAFT: ["ISSUED", "VOID"], ISSUED: ["PAID", "VOID"] };
      if (!allowed[invoice.status]?.includes(input.data.status)) throw forbidden("invalid_invoice_transition", `Invoice cannot move from ${invoice.status} to ${input.data.status}.`, 409);
      if (input.data.status === "ISSUED" && !input.data.dueAt) throw forbidden("invoice_due_date_required", "Set a due date when issuing an invoice.", 422);
      if (input.data.status === "PAID" && invoice.status !== "ISSUED") throw forbidden("invoice_not_issued", "Only issued invoices can be marked paid.", 409);
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.staffingInvoice.update({ where: { id: invoice.id }, data: {
          status: input.data.status,
          ...(input.data.status === "ISSUED" ? { issuedAt: new Date(), dueAt: new Date(input.data.dueAt!) } : {}),
          ...(input.data.status === "PAID" ? { paidAt: input.data.paidAt ? new Date(input.data.paidAt) : new Date() } : {})
        } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "staffing.invoice.status.changed", entityType: "staffing_invoice", entityId: changed.id, metadata: { from: invoice.status, to: changed.status, amount: Number(changed.amount), currency: changed.currency, paidAt: changed.paidAt?.toISOString() ?? null } } });
        return changed;
      });
      return updated;
    });

    v1.get("/credits", {
      schema: { tags: ["Billing"], summary: "Credit balance and immutable ledger" }
    }, async (request) => {
      requirePermission(request, "billing.read");
      const [organization, ledger] = await Promise.all([
        prisma.organization.findUniqueOrThrow({ where: { id: request.organizationId }, select: { creditBalance: true } }),
        prisma.creditLedger.findMany({ where: { organizationId: request.organizationId }, orderBy: { createdAt: "desc" }, take: 100 })
      ]);
      return { balance: organization.creditBalance, ledger };
    });

    v1.post("/credits/checkout", {
      schema: { tags: ["Billing"], summary: "Create a provider-backed credit checkout" }
    }, async (request) => {
      requirePermission(request, "billing.manage");
      if (process.env.NODE_ENV === "production") throw forbidden("billing_provider_unavailable", "Checkout is disabled until a production payment provider is configured.", 503);
      const input = z.object({ productCode: z.enum(["CREDITS_100", "CREDITS_500", "CREDITS_2000"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_credit_product", "Choose a valid credit package.", 422);
      return localBilling.createCheckout({
        accountId: request.organizationId,
        productCode: input.data.productCode,
        successUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/workspace/settings?checkout=success`,
        cancelUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/workspace/settings?checkout=cancelled`
      });
    });

    v1.get("/student/practice", {
      schema: { tags: ["Candidate practice"], summary: "Read a student's saved readiness and practice history" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Practice history is only available to student accounts.");
      const profile = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, include: { user: { select: { name: true } } } });
      if (!profile) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      const attempts = await prisma.practiceAttempt.findMany({ where: { userId: request.currentUserId }, orderBy: { createdAt: "desc" }, take: 50 });
      const readiness = attempts.length ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.score, 0) / attempts.length) : null;
      const categories = ["TECHNICAL", "COMMUNICATION", "BEHAVIORAL"] as const;
      const levels = categories.map((category) => {
        const categoryAttempts = attempts.filter((attempt) => attempt.category === category);
        return { category, score: categoryAttempts.length ? Math.round(categoryAttempts.reduce((sum, attempt) => sum + attempt.score, 0) / categoryAttempts.length) : null, attempts: categoryAttempts.length };
      });
      return { profile: { name: profile.user.name, registrationNo: profile.registrationNo, branch: profile.branch, graduationYear: profile.graduationYear, cgpa: profile.cgpa === null ? null : Number(profile.cgpa), correction: profile.profileCorrection, correctionAt: profile.profileCorrectionAt }, readiness, attempts, levels };
    });

    v1.patch("/student/profile", {
      schema: { tags: ["Student placement"], summary: "Request a correction to the student's academic profile" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Only a student can update this profile.");
      const input = z.object({
        branch: z.string().trim().min(2).max(80),
        graduationYear: z.number().int().min(new Date().getFullYear()).max(new Date().getFullYear() + 10),
        cgpa: z.number().min(0).max(10).nullable()
      }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_student_profile", "Provide a branch, a valid graduation year, and a CGPA from 0 to 10 (or null).", 422);
      const profile = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId } });
      if (!profile) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      if (profile.profileCorrection) throw forbidden("profile_correction_pending", "Your academic profile already has a correction awaiting university review.", 409);
      const updated = await prisma.studentProfile.update({ where: { id: profile.id }, data: { profileCorrection: input.data, profileCorrectionAt: new Date() } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "student.profile.correction.requested", entityType: "student_profile", entityId: profile.id, metadata: { current: { branch: profile.branch, graduationYear: profile.graduationYear, cgpa: profile.cgpa }, requested: input.data } } });
      return { status: "PENDING_REVIEW", correction: updated.profileCorrection, correctionAt: updated.profileCorrectionAt };
    });

    v1.post("/student/practice/attempts", {
      schema: { tags: ["Candidate practice"], summary: "Evaluate and save an advisory practice response" }
    }, async (request, reply) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Practice attempts are only available to student accounts.");
      if (production) throw forbidden("practice_evaluator_unavailable", "Practice evaluation is disabled until a reviewed production provider is configured.", 503);
      const profile = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, select: { id: true } });
      if (!profile) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      const input = z.object({ category: z.enum(["TECHNICAL", "COMMUNICATION", "BEHAVIORAL"]), response: z.string().trim().min(30).max(10_000) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_practice_response", "Choose a practice category and provide a response of at least 30 characters.", 422);
      const rubric = {
        TECHNICAL: [{ name: "Problem solving", weight: 35 }, { name: "Technical reasoning", weight: 35 }, { name: "Trade-off awareness", weight: 30 }],
        COMMUNICATION: [{ name: "Clarity", weight: 35 }, { name: "Structure", weight: 35 }, { name: "Audience awareness", weight: 30 }],
        BEHAVIORAL: [{ name: "Ownership", weight: 35 }, { name: "Collaboration", weight: 35 }, { name: "Learning", weight: 30 }]
      }[input.data.category];
      const prompt = {
        TECHNICAL: "Describe a technical problem you solved. Explain the constraints, the approach you chose, and the trade-offs you considered.",
        COMMUNICATION: "Explain a complex project to a non-specialist teammate. What did you emphasize, and how did you check for understanding?",
        BEHAVIORAL: "Describe a time you changed your approach after feedback. What did you learn and what did you do next?"
      }[input.data.category];
      const attemptId = randomBytes(16).toString("hex");
      const evaluation = await localEvaluator.evaluate({
        assessmentId: attemptId,
        jobDescription: `Candidate preparation rubric for ${input.data.category.toLowerCase()} skills.`,
        response: input.data.response,
        criteria: rubric
      });
      const attempt = await prisma.practiceAttempt.create({
        data: { id: attemptId, userId: request.currentUserId, category: input.data.category, prompt, response: input.data.response, score: evaluation.overallScore, feedback: evaluation as object }
      });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "student.practice.created", entityType: "practice_attempt", entityId: attempt.id, metadata: { category: attempt.category, advisoryOnly: true } } });
      return reply.status(201).send({ attempt, advisoryOnly: true });
    });

    v1.get("/student/drives", {
      schema: { tags: ["Student placement"], summary: "List open drives and the current student's eligibility" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Placement drives are only available to student accounts.");
      const student = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, include: { applications: { include: { offer: true, drive: { select: { seasonId: true } } } } } });
      if (!student) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      const drives = await prisma.placementDrive.findMany({
        where: { season: { organizationId: request.organizationId }, status: "PUBLISHED", applyBy: { gte: new Date() } },
        include: { company: { select: { name: true } }, season: { select: { offerCap: true, upgradeMultiple: true } } },
        orderBy: { applyBy: "asc" }
      });
      return { object: "list", data: drives.map((drive) => {
        const accepted = student.applications.filter((application) => application.drive.seasonId === drive.seasonId && (["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status))));
        const currentCtc = accepted.reduce<number | null>((highest, application) => {
          const value = application.offer ? Number(application.offer.ctc) : null;
          return value === null ? highest : highest === null ? value : Math.max(highest, value);
        }, student.currentCtc === null ? null : Number(student.currentCtc));
        return {
        id: drive.id,
        title: drive.title,
        description: drive.description,
        applyBy: drive.applyBy,
        openings: drive.openings,
        locations: drive.locations,
        eligibleBranches: drive.eligibleBranches,
        minCgpa: drive.minCgpa,
        ctcMin: drive.ctcMin,
        ctcMax: drive.ctcMax,
        currency: drive.currency,
        company: drive.company,
        applied: student.applications.some((application) => application.driveId === drive.id),
        eligibility: checkPlacementEligibility(
          { branch: student.branch, cgpa: student.cgpa === null ? null : Number(student.cgpa), blacklisted: student.blacklisted, placed: student.placed, acceptedOffers: accepted.length, currentCtc },
          { eligibleBranches: drive.eligibleBranches, minCgpa: drive.minCgpa === null ? null : Number(drive.minCgpa), allowPlaced: drive.allowPlaced, ctcMax: drive.ctcMax === null ? null : Number(drive.ctcMax) },
          { offerCap: drive.season.offerCap, upgradeMultiple: drive.season.upgradeMultiple === null ? null : Number(drive.season.upgradeMultiple) }
        )
      }; }) };
    });

    v1.get("/student/applications", {
      schema: { tags: ["Student placement"], summary: "List the signed-in student's applications and offer details" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Placement history is only available to student accounts.");
      const student = await prisma.studentProfile.findFirst({
        where: { userId: request.currentUserId, organizationId: request.organizationId },
        select: { id: true }
      });
      if (!student) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      const applications = await prisma.application.findMany({
        where: { studentId: student.id, drive: { season: { organizationId: request.organizationId } } },
        include: { drive: { include: { company: { select: { name: true } }, season: { select: { name: true, academicYear: true } } } }, offer: true },
        orderBy: { appliedAt: "desc" }
      });
      return { object: "list", data: applications.map(({ id, status, appliedAt, drive, offer }) => ({
        id, status, appliedAt,
        drive: { title: drive.title, company: drive.company.name, season: drive.season.name, academicYear: drive.season.academicYear },
        offer: offer ? { id: offer.id, status: offer.status, ctc: offer.ctc, currency: offer.currency, joiningDate: offer.joiningDate } : null
      })) };
    });

    v1.get("/student/notifications", {
      schema: { tags: ["Student placement"], summary: "List the signed-in student's placement notifications" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Notifications are only available to student accounts.");
      const [data, unreadCount] = await Promise.all([
        prisma.userNotification.findMany({ where: { userId: request.currentUserId, organizationId: request.organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
        prisma.userNotification.count({ where: { userId: request.currentUserId, organizationId: request.organizationId, readAt: null } })
      ]);
      return { object: "list", data, unreadCount };
    });

    v1.patch<{ Params: { notificationId: string } }>("/student/notifications/:notificationId/read", {
      schema: { tags: ["Student placement"], summary: "Mark one of the signed-in student's notifications as read" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Notifications are only available to student accounts.");
      const updated = await prisma.userNotification.updateMany({ where: { id: request.params.notificationId, userId: request.currentUserId, organizationId: request.organizationId, readAt: null }, data: { readAt: new Date() } });
      if (!updated.count) {
        const existing = await prisma.userNotification.findFirst({ where: { id: request.params.notificationId, userId: request.currentUserId, organizationId: request.organizationId } });
        if (!existing) throw forbidden("notification_not_found", "Notification was not found for this student.", 404);
        return existing;
      }
      return prisma.userNotification.findFirstOrThrow({ where: { id: request.params.notificationId, userId: request.currentUserId, organizationId: request.organizationId } });
    });

    v1.post("/student/applications", {
      schema: { tags: ["Student placement"], summary: "Apply the signed-in student to an eligible published drive" }
    }, async (request, reply) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Only a student can submit a self-service application.");
      const input = z.object({ driveId: z.string().min(1) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_application", "Select a placement drive.", 422);
      const student = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, include: { applications: { include: { offer: true, drive: { select: { seasonId: true } } } } } });
      const drive = await prisma.placementDrive.findFirst({ where: { id: input.data.driveId, season: { organizationId: request.organizationId } }, include: { season: true } });
      if (!student || !drive) throw forbidden("placement_target_not_found", "Student profile or drive was not found in this university.", 404);
      if (drive.status !== "PUBLISHED" || drive.applyBy < new Date()) throw forbidden("drive_closed", "This drive is not accepting applications.", 409);
      if (student.applications.some((application) => application.driveId === drive.id)) throw forbidden("already_applied", "You already applied to this drive.", 409);
      const applicationsCount = await prisma.application.count({ where: { driveId: drive.id, status: { notIn: ["REJECTED", "WITHDRAWN"] } } });
      if (applicationsCount >= drive.openings) throw forbidden("drive_full", "All available openings for this drive have been filled.", 409);
      const accepted = student.applications.filter((application) => application.drive.seasonId === drive.seasonId && (["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status))));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, student.currentCtc === null ? null : Number(student.currentCtc));
      const eligibility = checkPlacementEligibility(
        { branch: student.branch, cgpa: student.cgpa === null ? null : Number(student.cgpa), blacklisted: student.blacklisted, placed: student.placed, acceptedOffers: accepted.length, currentCtc },
        { eligibleBranches: drive.eligibleBranches, minCgpa: drive.minCgpa === null ? null : Number(drive.minCgpa), allowPlaced: drive.allowPlaced, ctcMax: drive.ctcMax === null ? null : Number(drive.ctcMax) },
        { offerCap: drive.season.offerCap, upgradeMultiple: drive.season.upgradeMultiple === null ? null : Number(drive.season.upgradeMultiple) }
      );
      if (!eligibility.eligible) throw forbidden("student_ineligible", eligibility.reasons.join("; "), 409);
      const { application, deliveries } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PlacementDrive" WHERE "id" = ${drive.id} FOR UPDATE`;
        const currentDrive = await tx.placementDrive.findUniqueOrThrow({ where: { id: drive.id } });
        if (currentDrive.status !== "PUBLISHED" || currentDrive.applyBy < new Date()) throw forbidden("drive_closed", "This drive is not accepting applications.", 409);
        if (await tx.application.findUnique({ where: { driveId_studentId: { driveId: drive.id, studentId: student.id } } })) throw forbidden("already_applied", "You already applied to this drive.", 409);
        if (await tx.application.count({ where: { driveId: drive.id, status: { notIn: ["REJECTED", "WITHDRAWN"] } } }) >= currentDrive.openings) throw forbidden("drive_full", "All available openings for this drive have been filled.", 409);
        const application = await tx.application.create({ data: { driveId: drive.id, studentId: student.id }, select: { id: true, status: true, appliedAt: true } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "student.placement.application.created", entityType: "application", entityId: application.id, metadata: { driveId: drive.id } } });
        const deliveries = await persistWebhookEvent(tx, request.organizationId, "placement.application.created", { application_id: application.id, drive_id: drive.id, student_id: student.id });
        return { application, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(201).send(application);
    });

    v1.get("/placements/drives", {
      schema: { tags: ["Placements"], summary: "List placement drives and outcomes" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const data = await prisma.placementDrive.findMany({
        where: { season: { organizationId: request.organizationId } },
        include: {
          company: true,
          season: { select: { id: true, name: true, academicYear: true, offerCap: true, upgradeMultiple: true } },
          applications: { include: { offer: true, student: { include: { user: { select: { name: true, email: true } } } } } }
        },
        orderBy: { applyBy: "asc" }
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.get("/placements/config", {
      schema: { tags: ["Placements"], summary: "List season and company options for drive authoring" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const [seasons, companies] = await Promise.all([
        prisma.placementSeason.findMany({ where: { organizationId: request.organizationId }, orderBy: [{ active: "desc" }, { createdAt: "desc" }] }),
        prisma.placementCompany.findMany({ where: { organizationId: request.organizationId }, orderBy: { name: "asc" } })
      ]);
      return { seasons, companies };
    });

    v1.post("/placements/seasons", {
      schema: { tags: ["Placements"], summary: "Create an academic placement season and offer policy" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ name: z.string().trim().min(3).max(120), academicYear: z.string().regex(/^\d{4}-\d{2}$/), offerCap: z.number().int().min(1).max(20).default(1), upgradeMultiple: z.number().min(1).max(10).nullable().default(null), active: z.boolean().default(true) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_placement_season", "Season details and offer policy are invalid.", 422);
      const season = await prisma.$transaction(async (tx) => {
        if (input.data.active) await tx.placementSeason.updateMany({ where: { organizationId: request.organizationId, active: true }, data: { active: false } });
        const created = await tx.placementSeason.create({ data: { organizationId: request.organizationId, name: input.data.name, academicYear: input.data.academicYear, active: input.data.active, offerCap: input.data.offerCap, upgradeMultiple: input.data.upgradeMultiple } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.season.created", entityType: "placement_season", entityId: created.id, metadata: { academicYear: created.academicYear, active: created.active, offerCap: created.offerCap, upgradeMultiple: created.upgradeMultiple === null ? null : Number(created.upgradeMultiple) } } });
        return created;
      });
      return reply.status(201).send(season);
    });

    v1.patch<{ Params: { seasonId: string } }>("/placements/seasons/:seasonId", {
      schema: { tags: ["Placements"], summary: "Update a season offer policy or active status" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ name: z.string().trim().min(3).max(120).optional(), active: z.boolean().optional(), offerCap: z.number().int().min(1).max(20).optional(), upgradeMultiple: z.number().min(1).max(10).nullable().optional() }).refine((value) => Object.keys(value).length > 0).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_placement_season", "Provide valid season details or offer policy fields.", 422);
      const existing = await prisma.placementSeason.findFirst({ where: { id: request.params.seasonId, organizationId: request.organizationId }, select: { id: true } });
      if (!existing) throw forbidden("placement_season_not_found", "Placement season was not found in this university.", 404);
      const updated = await prisma.$transaction(async (tx) => {
        if (input.data.active) await tx.placementSeason.updateMany({ where: { organizationId: request.organizationId, active: true, id: { not: existing.id } }, data: { active: false } });
        const changed = await tx.placementSeason.update({ where: { id: existing.id }, data: {
          ...(input.data.name === undefined ? {} : { name: input.data.name }),
          ...(input.data.active === undefined ? {} : { active: input.data.active }),
          ...(input.data.offerCap === undefined ? {} : { offerCap: input.data.offerCap }),
          ...(input.data.upgradeMultiple === undefined ? {} : { upgradeMultiple: input.data.upgradeMultiple })
        } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.season.updated", entityType: "placement_season", entityId: changed.id, metadata: { fields: Object.keys(input.data) } } });
        return changed;
      });
      return updated;
    });

    v1.post("/placements/companies", {
      schema: { tags: ["Placements"], summary: "Create a placement company contact" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ name: z.string().trim().min(2).max(120), tier: z.string().trim().min(2).max(40).default("ENTERPRISE"), recruiterName: z.string().trim().max(120).nullable().optional(), recruiterEmail: z.email().nullable().optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_placement_company", "Company and recruiter details are invalid.", 422);
      const company = await prisma.placementCompany.create({ data: {
        organizationId: request.organizationId, name: input.data.name, tier: input.data.tier,
        ...(input.data.recruiterName === undefined ? {} : { recruiterName: input.data.recruiterName }),
        ...(input.data.recruiterEmail === undefined ? {} : { recruiterEmail: input.data.recruiterEmail })
      } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.company.created", entityType: "placement_company", entityId: company.id } });
      return reply.status(201).send(company);
    });

    v1.patch<{ Params: { companyId: string } }>("/placements/companies/:companyId", {
      schema: { tags: ["Placements"], summary: "Update placement company and recruiter details" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ name: z.string().trim().min(2).max(120).optional(), tier: z.string().trim().min(2).max(40).optional(), recruiterName: z.string().trim().max(120).nullable().optional(), recruiterEmail: z.email().nullable().optional() }).refine((value) => Object.keys(value).length > 0).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_placement_company", "Provide valid company or recruiter fields.", 422);
      const existing = await prisma.placementCompany.findFirst({ where: { id: request.params.companyId, organizationId: request.organizationId }, select: { id: true } });
      if (!existing) throw forbidden("placement_company_not_found", "Placement company was not found in this university.", 404);
      const company = await prisma.placementCompany.update({ where: { id: existing.id }, data: {
        ...(input.data.name === undefined ? {} : { name: input.data.name }),
        ...(input.data.tier === undefined ? {} : { tier: input.data.tier }),
        ...(input.data.recruiterName === undefined ? {} : { recruiterName: input.data.recruiterName }),
        ...(input.data.recruiterEmail === undefined ? {} : { recruiterEmail: input.data.recruiterEmail })
      } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.company.updated", entityType: "placement_company", entityId: company.id, metadata: { fields: Object.keys(input.data) } } });
      return company;
    });

    v1.delete<{ Params: { companyId: string } }>("/placements/companies/:companyId", {
      schema: { tags: ["Placements"], summary: "Delete a placement company with no associated drives" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const company = await prisma.placementCompany.findFirst({ where: { id: request.params.companyId, organizationId: request.organizationId }, include: { _count: { select: { drives: true } } } });
      if (!company) throw forbidden("placement_company_not_found", "Placement company was not found in this university.", 404);
      if (company._count.drives > 0) throw forbidden("placement_company_in_use", "A company with placement drives cannot be deleted.", 409);
      await prisma.$transaction([
        prisma.placementCompany.delete({ where: { id: company.id } }),
        prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.company.deleted", entityType: "placement_company", entityId: company.id, metadata: { name: company.name } } })
      ]);
      return reply.status(204).send();
    });

    v1.post("/placements/drives", {
      schema: { tags: ["Placements"], summary: "Create a draft placement drive" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({
        seasonId: z.string().min(1), companyId: z.string().min(1), title: z.string().trim().min(3).max(140),
        description: z.string().trim().min(30).max(5000), jobType: z.string().trim().min(2).max(40),
        locations: z.array(z.string().trim().min(2).max(100)).min(1).max(10),
        applyBy: z.iso.datetime(), openings: z.number().int().min(1).max(10_000),
        ctcMin: z.number().nonnegative().nullable().optional(), ctcMax: z.number().nonnegative().nullable().optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).default("INR"), eligibleBranches: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
        minCgpa: z.number().min(0).max(10).nullable().optional(), allowPlaced: z.boolean().default(false)
      }).refine((value) => value.ctcMin == null || value.ctcMax == null || value.ctcMax >= value.ctcMin).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_drive", "Drive details are invalid.", 422);
      const applyBy = new Date(input.data.applyBy);
      if (applyBy <= new Date()) throw forbidden("invalid_deadline", "The application deadline must be in the future.", 422);
      const [season, company] = await Promise.all([
        prisma.placementSeason.findFirst({ where: { id: input.data.seasonId, organizationId: request.organizationId }, select: { id: true, active: true } }),
        prisma.placementCompany.findFirst({ where: { id: input.data.companyId, organizationId: request.organizationId }, select: { id: true } })
      ]);
      if (!season || !company) throw forbidden("placement_target_not_found", "Season or company was not found in this university.", 404);
      if (!season.active) throw forbidden("season_inactive", "A drive can only be added to an active season.", 409);
      const drive = await prisma.placementDrive.create({ data: {
        seasonId: season.id,
        companyId: company.id,
        title: input.data.title,
        description: input.data.description,
        status: "DRAFT",
        jobType: input.data.jobType,
        locations: input.data.locations,
        applyBy,
        openings: input.data.openings,
        ctcMin: input.data.ctcMin ?? null,
        ctcMax: input.data.ctcMax ?? null,
        currency: input.data.currency,
        eligibleBranches: input.data.eligibleBranches,
        minCgpa: input.data.minCgpa ?? null,
        allowPlaced: input.data.allowPlaced
      }, include: { company: true, season: true, applications: true } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.drive.created", entityType: "placement_drive", entityId: drive.id } });
      return reply.status(201).send(drive);
    });

    v1.patch<{ Params: { driveId: string } }>("/placements/drives/:driveId/status", {
      schema: { tags: ["Placements"], summary: "Propose, publish, or close a placement drive" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ status: z.enum(["PROPOSED", "PUBLISHED", "CLOSED"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_drive_status", "Choose a valid drive status.", 422);
      const drive = await prisma.placementDrive.findFirst({ where: { id: request.params.driveId, season: { organizationId: request.organizationId } }, select: { id: true, status: true, applyBy: true } });
      if (!drive) throw forbidden("placement_drive_not_found", "Drive was not found in this university.", 404);
      const allowed: Record<string, readonly string[]> = { DRAFT: ["PROPOSED", "PUBLISHED"], PROPOSED: ["DRAFT", "PUBLISHED"], PUBLISHED: ["CLOSED"] };
      if (!allowed[drive.status]?.includes(input.data.status)) throw forbidden("invalid_drive_transition", `Drive cannot move from ${drive.status} to ${input.data.status}.`, 409);
      if (input.data.status === "PUBLISHED" && drive.applyBy <= new Date()) throw forbidden("drive_deadline_passed", "A drive cannot be published after its application deadline.", 409);
      const updated = await prisma.placementDrive.update({ where: { id: drive.id }, data: { status: input.data.status } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.drive.status.changed", entityType: "placement_drive", entityId: drive.id, metadata: { from: drive.status, to: updated.status } } });
      return updated;
    });

    v1.get("/placements/overview", {
      schema: { tags: ["Placements"], summary: "Placement readiness and season totals" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const [students, drives, applications, placed] = await Promise.all([
        prisma.studentProfile.count({ where: { organizationId: request.organizationId } }),
        prisma.placementDrive.count({ where: { season: { organizationId: request.organizationId }, status: "PUBLISHED" } }),
        prisma.application.count({ where: { drive: { season: { organizationId: request.organizationId } } } }),
        prisma.studentProfile.count({ where: { organizationId: request.organizationId, placed: true } })
      ]);
      const season = await prisma.placementSeason.findFirst({
        where: { organizationId: request.organizationId, active: true },
        select: { name: true, academicYear: true },
        orderBy: { createdAt: "desc" }
      });
      return { season, students, activeDrives: drives, applications, placed, placementRate: students ? Math.round((placed / students) * 100) : 0 };
    });

    v1.get("/placements/students", {
      schema: { tags: ["Placements"], summary: "List students in the university workspace" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const data = await prisma.studentProfile.findMany({
        where: { organizationId: request.organizationId },
        include: { user: { select: { id: true, name: true, email: true } }, batch: { include: { campus: true } }, applications: { include: { offer: true, drive: { select: { id: true, title: true } } } } },
        orderBy: { registrationNo: "asc" }
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.post("/placements/students/import", {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { tags: ["Placements"], summary: "Bulk upsert student profiles and invite new workspace members" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ students: z.array(z.object({
        name: z.string().trim().min(2).max(120),
        email: z.email(),
        registrationNo: z.string().trim().min(1).max(40),
        branch: z.string().trim().min(1).max(80),
        graduationYear: z.number().int().min(1900).max(2200),
        cgpa: z.number().min(0).max(10).nullable().optional()
      }).strict()).min(1).max(500) }).superRefine(({ students }, context) => {
        const emails = new Set<string>();
        const registrationNumbers = new Set<string>();
        students.forEach((student, index) => {
          const email = student.email.trim().toLowerCase();
          const registrationNo = student.registrationNo.trim().toLowerCase();
          if (emails.has(email)) context.addIssue({ code: "custom", path: ["students", index, "email"], message: "Email is duplicated in this import." });
          if (registrationNumbers.has(registrationNo)) context.addIssue({ code: "custom", path: ["students", index, "registrationNo"], message: "Registration number is duplicated in this import." });
          emails.add(email);
          registrationNumbers.add(registrationNo);
        });
      }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_student_import", "Provide 1–500 valid, non-duplicated student rows.", 422);
      const organization = await prisma.organization.findUnique({ where: { id: request.organizationId }, select: { name: true } });
      if (!organization) throw forbidden("university_workspace_required", "The university workspace was not found.", 404);
      const results: Array<{ email: string; registrationNo: string; profile: "created" | "updated"; invitationId: string | null; actionUrl?: string }> = [];
      const errors: Array<{ email: string; registrationNo: string; message: string }> = [];

      for (const row of input.data.students) {
        const email = row.email.trim().toLowerCase();
        try {
          const imported = await prisma.$transaction(async (tx) => {
            let user = await tx.user.findUnique({ where: { email } });
            if (!user) user = await tx.user.create({ data: { email, name: row.name } });
            const existingProfile = await tx.studentProfile.findUnique({ where: { userId: user.id }, select: { id: true, organizationId: true } });
            if (existingProfile && existingProfile.organizationId !== request.organizationId) throw new Error("student_profile_in_other_workspace");
            const membership = await tx.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: request.organizationId } }, select: { role: true } });
            if (membership && membership.role !== "STUDENT") throw new Error("account_has_non_student_role");
            const profile = existingProfile
              ? await tx.studentProfile.update({ where: { id: existingProfile.id }, data: { registrationNo: row.registrationNo.trim(), branch: row.branch.trim(), graduationYear: row.graduationYear, cgpa: row.cgpa ?? null } })
              : await tx.studentProfile.create({ data: { userId: user.id, organizationId: request.organizationId, registrationNo: row.registrationNo.trim(), branch: row.branch.trim(), graduationYear: row.graduationYear, cgpa: row.cgpa ?? null } });
            let invitationId: string | null = null;
            let actionUrl: string | undefined;
            if (!membership) {
              await tx.workspaceInvitation.updateMany({ where: { organizationId: request.organizationId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
              const rawToken = accountToken();
              const invitation = await tx.workspaceInvitation.create({ data: { organizationId: request.organizationId, invitedById: request.currentUserId, email, role: "STUDENT", tokenHash: tokenHash(rawToken), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000) } });
              invitationId = invitation.id;
              actionUrl = accountLink("/invite/accept", rawToken);
              await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "workspace.invitation.created", entityType: "workspace_invitation", entityId: invitation.id, metadata: { email, role: "STUDENT", source: "student_bulk_import" } } });
            }
            await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: existingProfile ? "student.profile.import_updated" : "student.profile.imported", entityType: "student_profile", entityId: profile.id, metadata: { registrationNo: profile.registrationNo, branch: profile.branch, invited: Boolean(invitationId) } } });
            return { profileState: existingProfile ? "updated" as const : "created" as const, invitationId, actionUrl };
          });
          if (imported.invitationId && imported.actionUrl) {
            try {
              await deliverAccountEmail({ to: email, subject: `Join ${organization.name} as a student`, link: imported.actionUrl, action: `accept your student invitation to ${organization.name}` });
            } catch {
              await prisma.workspaceInvitation.updateMany({ where: { id: imported.invitationId, organizationId: request.organizationId, acceptedAt: null }, data: { revokedAt: new Date() } });
              errors.push({ email, registrationNo: row.registrationNo, message: "Profile imported, but the invitation could not be delivered. Send a new invitation before the student signs in." });
              results.push({ email, registrationNo: row.registrationNo, profile: imported.profileState, invitationId: null });
              continue;
            }
          }
          results.push({ email, registrationNo: row.registrationNo, profile: imported.profileState, invitationId: imported.invitationId, ...(!production && imported.actionUrl ? { actionUrl: imported.actionUrl } : {}) });
        } catch (error) {
          const message = error instanceof Error && error.message === "student_profile_in_other_workspace"
            ? "This account already has a student profile in another university workspace."
            : error instanceof Error && error.message === "account_has_non_student_role"
              ? "This account is already a non-student member of this workspace."
              : typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
                ? "The email or registration number conflicts with an existing student record."
                : "This student row could not be imported.";
          errors.push({ email, registrationNo: row.registrationNo, message });
        }
      }
      return reply.send({ imported: results.length, created: results.filter((item) => item.profile === "created").length, updated: results.filter((item) => item.profile === "updated").length, invited: results.filter((item) => item.invitationId !== null).length, students: results, errors });
    });

    v1.patch<{ Params: { studentId: string } }>("/placements/students/:studentId/profile-correction", {
      schema: { tags: ["Placements"], summary: "Approve or decline a student's academic-profile correction request" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ decision: z.enum(["APPROVE", "DECLINE"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_profile_correction_decision", "Choose whether to approve or decline the requested correction.", 422);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "StudentProfile" WHERE "id" = ${request.params.studentId} AND "organizationId" = ${request.organizationId} FOR UPDATE`;
        const student = await tx.studentProfile.findFirst({ where: { id: request.params.studentId, organizationId: request.organizationId }, select: { id: true, userId: true, branch: true, graduationYear: true, cgpa: true, profileCorrection: true } });
        if (!student) throw forbidden("student_not_found", "Student was not found in this university.", 404);
        if (!student.profileCorrection) throw forbidden("profile_correction_not_found", "This student has no pending profile correction.", 409);
        const correction = z.object({ branch: z.string().trim().min(2).max(80), graduationYear: z.number().int().min(new Date().getFullYear()).max(new Date().getFullYear() + 10), cgpa: z.number().min(0).max(10).nullable() }).safeParse(student.profileCorrection);
        if (!correction.success) throw forbidden("invalid_stored_profile_correction", "The stored profile correction is invalid and requires support review.", 409);
        const updated = await tx.studentProfile.update({ where: { id: student.id }, data: {
          ...(input.data.decision === "APPROVE" ? correction.data : {}),
          profileCorrection: Prisma.DbNull,
          profileCorrectionAt: null
        } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: `student.profile.correction.${input.data.decision.toLowerCase()}`, entityType: "student_profile", entityId: student.id, metadata: {
          previous: { branch: student.branch, graduationYear: student.graduationYear, cgpa: student.cgpa === null ? null : Number(student.cgpa) },
          requested: correction.data,
          decision: input.data.decision
        } } });
        await createStudentNotification(tx, { userId: student.userId, organizationId: request.organizationId, type: "profile_correction.reviewed", title: `Academic profile correction ${input.data.decision.toLowerCase()}d`, body: input.data.decision === "APPROVE" ? "Your university approved your academic profile correction. Eligibility now uses the verified values." : "Your university declined your academic profile correction. Your verified profile remains unchanged.", data: { studentProfileId: student.id, decision: input.data.decision } });
        return { id: updated.id, branch: updated.branch, graduationYear: updated.graduationYear, cgpa: updated.cgpa === null ? null : Number(updated.cgpa), profileCorrection: updated.profileCorrection };
      });
    });

    v1.patch<{ Params: { studentId: string } }>("/placements/students/:studentId/reconciliation", {
      schema: { tags: ["Placements"], summary: "Reconcile an existing placement status and compensation with its source" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ placed: z.boolean(), currentCtc: z.number().positive().max(1_000_000_000).nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), source: z.string().trim().min(3).max(300).nullable() })
        .refine((value) => value.placed ? value.currentCtc !== null && value.currency !== null && value.source !== null : value.currentCtc === null && value.currency === null)
        .safeParse(request.body);
      if (!input.success) throw forbidden("invalid_placement_reconciliation", "Placed students require a current CTC, currency, and source; clear all three when reconciling an unplaced student.", 422);
      const student = await prisma.studentProfile.findFirst({ where: { id: request.params.studentId, organizationId: request.organizationId }, select: { id: true, placed: true, currentCtc: true, currentCtcCurrency: true, placementSource: true, placementVerifiedAt: true } });
      if (!student) throw forbidden("student_not_found", "Student was not found in this university.", 404);
      return prisma.$transaction(async (tx) => {
        const reconciledAt = input.data.placed ? new Date() : null;
        const updated = await tx.studentProfile.update({ where: { id: student.id }, data: {
          placed: input.data.placed,
          currentCtc: input.data.currentCtc,
          currentCtcCurrency: input.data.currency,
          placementSource: input.data.placed ? input.data.source : null,
          placementVerifiedAt: reconciledAt
        } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.student.reconciled", entityType: "student_profile", entityId: student.id, metadata: {
          previous: { placed: student.placed, currentCtc: student.currentCtc === null ? null : Number(student.currentCtc), currency: student.currentCtcCurrency, source: student.placementSource, verifiedAt: student.placementVerifiedAt?.toISOString() ?? null },
          reconciled: { placed: updated.placed, currentCtc: updated.currentCtc === null ? null : Number(updated.currentCtc), currency: updated.currentCtcCurrency, source: updated.placementSource, verifiedAt: updated.placementVerifiedAt?.toISOString() ?? null }
        } } });
        return updated;
      });
    });

    v1.get<{ Params: { driveId: string; studentId: string } }>("/placements/drives/:driveId/eligibility/:studentId", {
      schema: { tags: ["Placements"], summary: "Explain a student's placement-drive eligibility" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const [drive, student] = await Promise.all([
        prisma.placementDrive.findFirst({ where: { id: request.params.driveId, season: { organizationId: request.organizationId } }, include: { season: true } }),
        prisma.studentProfile.findFirst({ where: { id: request.params.studentId, organizationId: request.organizationId }, include: { applications: { include: { offer: true, drive: { select: { seasonId: true } } } } } })
      ]);
      if (!drive || !student) throw forbidden("placement_target_not_found", "Drive or student was not found in this university.", 404);
      const accepted = student.applications.filter((application) => application.drive.seasonId === drive.seasonId && (["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status))));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, student.currentCtc === null ? null : Number(student.currentCtc));
      return {
        eligibility: checkPlacementEligibility(
          { branch: student.branch, cgpa: student.cgpa === null ? null : Number(student.cgpa), blacklisted: student.blacklisted, placed: student.placed, acceptedOffers: accepted.length, currentCtc },
          { eligibleBranches: drive.eligibleBranches, minCgpa: drive.minCgpa === null ? null : Number(drive.minCgpa), allowPlaced: drive.allowPlaced, ctcMax: drive.ctcMax === null ? null : Number(drive.ctcMax) },
          { offerCap: drive.season.offerCap, upgradeMultiple: drive.season.upgradeMultiple === null ? null : Number(drive.season.upgradeMultiple) }
        )
      };
    });

    v1.post("/placements/applications", {
      schema: { tags: ["Placements"], summary: "Record an eligible student application to a published drive" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ driveId: z.string().min(1), studentId: z.string().min(1) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_application", "Drive and student are required.", 422);
      const [drive, student] = await Promise.all([
        prisma.placementDrive.findFirst({ where: { id: input.data.driveId, season: { organizationId: request.organizationId } }, include: { season: true } }),
        prisma.studentProfile.findFirst({ where: { id: input.data.studentId, organizationId: request.organizationId }, include: { applications: { include: { offer: true, drive: { select: { seasonId: true } } } } } })
      ]);
      if (!drive || !student) throw forbidden("placement_target_not_found", "Drive or student was not found in this university.", 404);
      if (drive.status !== "PUBLISHED") throw forbidden("drive_not_open", "Only published placement drives accept applications.", 409);
      if (drive.applyBy < new Date()) throw forbidden("drive_closed", "The application deadline has passed.", 409);
      const accepted = student.applications.filter((application) => application.drive.seasonId === drive.seasonId && (["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status))));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, student.currentCtc === null ? null : Number(student.currentCtc));
      const eligibility = checkPlacementEligibility(
        { branch: student.branch, cgpa: student.cgpa === null ? null : Number(student.cgpa), blacklisted: student.blacklisted, placed: student.placed, acceptedOffers: accepted.length, currentCtc },
        { eligibleBranches: drive.eligibleBranches, minCgpa: drive.minCgpa === null ? null : Number(drive.minCgpa), allowPlaced: drive.allowPlaced, ctcMax: drive.ctcMax === null ? null : Number(drive.ctcMax) },
        { offerCap: drive.season.offerCap, upgradeMultiple: drive.season.upgradeMultiple === null ? null : Number(drive.season.upgradeMultiple) }
      );
      if (!eligibility.eligible) throw forbidden("student_ineligible", eligibility.reasons.join("; "), 409);
      const existingApplication = await prisma.application.findUnique({ where: { driveId_studentId: { driveId: drive.id, studentId: student.id } }, select: { id: true } });
      if (existingApplication) throw forbidden("already_applied", "This student already has an application for the selected drive.", 409);
      const applicationsCount = await prisma.application.count({ where: { driveId: drive.id, status: { notIn: ["REJECTED", "WITHDRAWN"] } } });
      if (applicationsCount >= drive.openings) throw forbidden("drive_full", "All available openings for this drive have been filled.", 409);
      const { application, deliveries } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PlacementDrive" WHERE "id" = ${drive.id} FOR UPDATE`;
      const currentDrive = await tx.placementDrive.findUniqueOrThrow({ where: { id: drive.id } });
      if (currentDrive.status !== "PUBLISHED" || currentDrive.applyBy < new Date()) throw forbidden("drive_closed", "This drive is not accepting applications.", 409);
      if (await tx.application.findUnique({ where: { driveId_studentId: { driveId: drive.id, studentId: student.id } } })) throw forbidden("already_applied", "Student already applied to this drive.", 409);
      if (await tx.application.count({ where: { driveId: drive.id, status: { notIn: ["REJECTED", "WITHDRAWN"] } } }) >= currentDrive.openings) throw forbidden("drive_full", "All available openings for this drive have been filled.", 409);
      const application = await tx.application.create({ data: { driveId: drive.id, studentId: student.id }, include: { drive: { select: { title: true } }, student: { select: { id: true, registrationNo: true, branch: true } } } });
      await tx.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "placement.application.created",
          entityType: "application",
          entityId: application.id,
          metadata: { driveId: drive.id, studentId: student.id }
        }
      });
      const deliveries = await persistWebhookEvent(tx, request.organizationId, "placement.application.created", { application_id: application.id, drive_id: application.driveId, student_id: application.studentId });
      return { application, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(201).send(application);
    });

    v1.patch<{ Params: { applicationId: string } }>("/placements/applications/:applicationId", {
      schema: { tags: ["Placements"], summary: "Advance or close a university application" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ status: z.enum(["SHORTLISTED", "INTERVIEWING", "REJECTED", "WITHDRAWN"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_application_status", "Choose a valid review status.", 422);
      const application = await prisma.application.findFirst({ where: { id: request.params.applicationId, drive: { season: { organizationId: request.organizationId } } }, include: { student: { select: { userId: true } }, drive: { select: { id: true, title: true } } } });
      if (!application) throw forbidden("application_not_found", "Application was not found in this university.", 404);
      const allowed: Record<string, readonly string[]> = { APPLIED: ["SHORTLISTED", "REJECTED", "WITHDRAWN"], SHORTLISTED: ["INTERVIEWING", "REJECTED", "WITHDRAWN"], INTERVIEWING: ["REJECTED", "WITHDRAWN"] };
      if (!allowed[application.status]?.includes(input.data.status)) throw forbidden("invalid_application_transition", `Application cannot move from ${application.status} to ${input.data.status}.`, 409);
      const updated = await prisma.$transaction(async (tx) => {
        const transition = await tx.application.updateMany({ where: { id: application.id, status: application.status }, data: { status: input.data.status } });
        if (transition.count !== 1) throw forbidden("application_changed", "This application changed while you were reviewing it. Refresh and try again.", 409);
        const changed = await tx.application.findUniqueOrThrow({ where: { id: application.id } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.application.status.changed", entityType: "application", entityId: application.id, metadata: { from: application.status, to: changed.status, driveId: application.driveId } } });
        await createStudentNotification(tx, { userId: application.student.userId, organizationId: request.organizationId, type: "placement.application.updated", title: "Application status updated", body: `Your application for ${application.drive.title} is now ${changed.status.toLowerCase().replaceAll("_", " ")}.`, data: { applicationId: application.id, driveId: application.driveId, status: changed.status } });
        return changed;
      });
      return updated;
    });

    v1.post("/placements/offers", {
      schema: { tags: ["Placements"], summary: "Issue a formal offer to an interviewed applicant" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ applicationId: z.string().min(1), ctc: z.number().positive().max(1_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/).default("INR"), joiningDate: z.iso.datetime().optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_offer", "Offer amount, currency, or joining date is invalid.", 422);
      const application = await prisma.application.findFirst({ where: { id: input.data.applicationId, drive: { season: { organizationId: request.organizationId } } }, include: { offer: true, student: { select: { id: true, userId: true } }, drive: { select: { id: true, title: true, seasonId: true, season: { select: { offerCap: true } } } } } });
      if (!application) throw forbidden("application_not_found", "Application was not found in this university.", 404);
      if (application.status !== "INTERVIEWING") throw forbidden("application_not_ready_for_offer", "Move the application to Interviewing before issuing an offer.", 409);
      if (application.offer) throw forbidden("offer_already_exists", "An offer already exists for this application.", 409);
      const offer = await prisma.$transaction(async (tx) => {
        // Serialize offer issuance for one student so parallel requests cannot exceed the season cap.
        await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "StudentProfile" WHERE "id" = ${application.student.id} FOR UPDATE`;
        const outstandingOffers = await tx.application.count({ where: {
          studentId: application.student.id,
          drive: { seasonId: application.drive.seasonId },
          status: { in: ["OFFERED", "ACCEPTED"] }
        } });
        if (outstandingOffers >= application.drive.season.offerCap) throw forbidden("student_offer_cap_reached", "The student has reached the offer cap for this placement season.", 409);
        const transition = await tx.application.updateMany({ where: { id: application.id, status: "INTERVIEWING" }, data: { status: "OFFERED" } });
        if (transition.count !== 1) throw forbidden("application_changed", "This application changed while you were issuing an offer. Refresh and try again.", 409);
        const created = await tx.offer.create({ data: { applicationId: application.id, ctc: input.data.ctc, currency: input.data.currency, joiningDate: input.data.joiningDate ? new Date(input.data.joiningDate) : null } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.offer.created", entityType: "offer", entityId: created.id, metadata: { applicationId: application.id, ctc: input.data.ctc, currency: input.data.currency } } });
        await createStudentNotification(tx, { userId: application.student.userId, organizationId: request.organizationId, type: "placement.offer.created", title: "A placement offer is available", body: `You have a new offer for ${application.drive.title}. Review the terms and respond in your student workspace.`, data: { offerId: created.id, applicationId: application.id, driveId: application.drive.id } });
        return created;
      });
      return reply.status(201).send(offer);
    });

    v1.patch<{ Params: { offerId: string } }>("/placements/offers/:offerId", {
      schema: { tags: ["Placements"], summary: "Record an offer acceptance or joining outcome" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ status: z.enum(["ACCEPTED", "JOINED", "DEFERRED", "DECLINED", "REVOKED", "RENEGED"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_offer_status", "Choose a valid offer outcome.", 422);
      const offer = await prisma.offer.findFirst({ where: { id: request.params.offerId, application: { drive: { season: { organizationId: request.organizationId } } } }, include: { application: { include: { student: { select: { id: true, userId: true } }, drive: { select: { id: true, title: true } } } } } });
      if (!offer) throw forbidden("offer_not_found", "Offer was not found in this university.", 404);
      const allowed: Record<string, readonly string[]> = { ROLLED: ["ACCEPTED", "DECLINED", "REVOKED"], ACCEPTED: ["JOINED", "DEFERRED", "RENEGED"], DEFERRED: ["ACCEPTED", "DECLINED", "RENEGED"] };
      if (!allowed[offer.status]?.includes(input.data.status)) throw forbidden("invalid_offer_transition", `Offer cannot move from ${offer.status} to ${input.data.status}.`, 409);
      const updated = await prisma.$transaction(async (tx) => {
        const transition = await tx.offer.updateMany({ where: { id: offer.id, status: offer.status }, data: { status: input.data.status } });
        if (transition.count !== 1) throw forbidden("offer_changed", "This offer changed while you were recording its outcome. Refresh and try again.", 409);
        const changed = await tx.offer.findUniqueOrThrow({ where: { id: offer.id } });
        if (["ACCEPTED", "JOINED"].includes(input.data.status)) await tx.application.update({ where: { id: offer.application.id }, data: { status: "ACCEPTED" } });
        else if (["DECLINED", "REVOKED", "RENEGED"].includes(input.data.status)) await tx.application.update({ where: { id: offer.application.id }, data: { status: "REJECTED" } });
        if (input.data.status === "JOINED") await tx.studentProfile.update({ where: { id: offer.application.studentId }, data: { placed: true, currentCtc: offer.ctc, currentCtcCurrency: offer.currency, placementSource: "JOINED_OFFER", placementVerifiedAt: new Date() } });
        if (input.data.status === "RENEGED") {
          const otherJoined = await tx.offer.count({ where: { id: { not: offer.id }, status: "JOINED", application: { studentId: offer.application.studentId } } });
          if (otherJoined === 0) await tx.studentProfile.update({ where: { id: offer.application.studentId }, data: { placed: false, currentCtc: null, currentCtcCurrency: null, placementSource: null, placementVerifiedAt: null } });
        }
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.offer.status.changed", entityType: "offer", entityId: offer.id, metadata: { from: offer.status, to: changed.status, applicationId: offer.application.id } } });
        await createStudentNotification(tx, { userId: offer.application.student.userId, organizationId: request.organizationId, type: "placement.offer.updated", title: "Offer outcome updated", body: `The outcome for your ${offer.application.drive.title} offer is now ${changed.status.toLowerCase()}.`, data: { offerId: offer.id, applicationId: offer.application.id, driveId: offer.application.drive.id, status: changed.status } });
        return changed;
      });
      return updated;
    });

    v1.patch<{ Params: { offerId: string } }>("/student/offers/:offerId", {
      schema: { tags: ["Student placement"], summary: "Accept or decline an offer belonging to the signed-in student" }
    }, async (request) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Only a student can respond to a placement offer.");
      const input = z.object({ status: z.enum(["ACCEPTED", "DECLINED"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_offer_response", "Choose whether to accept or decline the offer.", 422);
      const offer = await prisma.offer.findFirst({
        where: { id: request.params.offerId, application: { student: { userId: request.currentUserId, organizationId: request.organizationId }, drive: { season: { organizationId: request.organizationId } } } },
        include: { application: { select: { id: true, status: true } } }
      });
      if (!offer) throw forbidden("offer_not_found", "Offer was not found for this student.", 404);
      if (offer.status !== "ROLLED") throw forbidden("offer_already_answered", "This offer can no longer be answered.", 409);
      const updated = await prisma.$transaction(async (tx) => {
        const transition = await tx.offer.updateMany({ where: { id: offer.id, status: "ROLLED" }, data: { status: input.data.status } });
        if (transition.count !== 1) throw forbidden("offer_already_answered", "This offer can no longer be answered. Refresh to see its current outcome.", 409);
        const changed = await tx.offer.findUniqueOrThrow({ where: { id: offer.id } });
        await tx.application.update({ where: { id: offer.application.id }, data: { status: input.data.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED" } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "student.placement.offer.responded", entityType: "offer", entityId: offer.id, metadata: { from: offer.status, to: changed.status, applicationId: offer.application.id } } });
        return changed;
      });
      return updated;
    });

    v1.get("/jobs", {
      schema: { tags: ["Jobs"], summary: "List jobs in the active organization" }
    }, async (request) => {
      requirePermission(request, "job.read");
      const data = await prisma.job.findMany({
        where: { organizationId: request.organizationId },
        include: { requirements: true, rounds: true, client: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" }
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.get("/candidates", {
      schema: { tags: ["Candidates"], summary: "List candidates in the active organization" }
    }, async (request) => {
      requirePermission(request, "candidate.read");
      const data = await prisma.candidate.findMany({
        where: { organizationId: request.organizationId },
        include: { candidateJobs: { include: { job: { select: { id: true, title: true } }, stage: { select: { id: true, name: true, color: true } } } } },
        orderBy: { updatedAt: "desc" },
        take: 100
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.get<{ Params: { candidateId: string } }>("/candidates/:candidateId/notes", {
      schema: { tags: ["Candidates"], summary: "List private notes for a candidate" }
    }, async (request) => {
      requirePermission(request, "candidate.read");
      const candidate = await prisma.candidate.findFirst({ where: { id: request.params.candidateId, organizationId: request.organizationId }, select: { id: true } });
      if (!candidate) throw forbidden("candidate_not_found", "Candidate was not found in this organization.", 404);
      return prisma.candidateNote.findMany({ where: { organizationId: request.organizationId, candidateId: candidate.id }, include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
    });

    v1.post<{ Params: { candidateId: string } }>("/candidates/:candidateId/notes", {
      schema: { tags: ["Candidates"], summary: "Add a private candidate note" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ content: z.string().trim().min(1).max(10_000) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_candidate_note", "A note must contain 1–10,000 characters.", 422);
      const candidate = await prisma.candidate.findFirst({ where: { id: request.params.candidateId, organizationId: request.organizationId }, select: { id: true } });
      if (!candidate) throw forbidden("candidate_not_found", "Candidate was not found in this organization.", 404);
      const note = await prisma.$transaction(async (tx) => {
        const created = await tx.candidateNote.create({ data: { organizationId: request.organizationId, candidateId: candidate.id, authorId: request.currentUserId, content: input.data.content }, include: { author: { select: { id: true, name: true } } } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "candidate.note.created", entityType: "candidate_note", entityId: created.id, metadata: { candidateId: candidate.id } } });
        return created;
      });
      return reply.status(201).send(note);
    });

    v1.get("/meetings", {
      schema: { tags: ["Meetings"], summary: "List meetings in the active organization" }
    }, async (request) => {
      requirePermission(request, "job.read");
      const data = await prisma.meeting.findMany({ where: { organizationId: request.organizationId }, include: { candidate: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, organizer: { select: { id: true, name: true } } }, orderBy: { startsAt: "asc" }, take: 200 });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.post("/meetings", {
      schema: { tags: ["Meetings"], summary: "Schedule a candidate or job meeting" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ title: z.string().trim().min(2).max(160), startsAt: z.iso.datetime(), durationMinutes: z.number().int().min(15).max(240).default(30), candidateId: z.string().min(1).optional(), jobId: z.string().min(1).optional(), location: z.string().trim().max(500).optional(), attendees: z.array(z.string().email()).max(50).default([]), notes: z.string().max(10_000).optional() }).refine((value) => value.candidateId || value.jobId, "Choose a candidate or a job.").safeParse(request.body);
      if (!input.success) throw forbidden("invalid_meeting", "Provide a title, valid time, duration, and candidate or job.", 422);
      const [candidate, job] = await Promise.all([
        input.data.candidateId ? prisma.candidate.findFirst({ where: { id: input.data.candidateId, organizationId: request.organizationId }, select: { id: true } }) : null,
        input.data.jobId ? prisma.job.findFirst({ where: { id: input.data.jobId, organizationId: request.organizationId }, select: { id: true } }) : null
      ]);
      if (input.data.candidateId && !candidate) throw forbidden("candidate_not_found", "Candidate was not found in this organization.", 404);
      if (input.data.jobId && !job) throw forbidden("job_not_found", "Job was not found in this organization.", 404);
      const { meeting, deliveries } = await prisma.$transaction(async (tx) => {
        const created = await tx.meeting.create({ data: { organizationId: request.organizationId, organizerId: request.currentUserId, title: input.data.title, startsAt: new Date(input.data.startsAt), durationMinutes: input.data.durationMinutes, ...(candidate ? { candidateId: candidate.id } : {}), ...(job ? { jobId: job.id } : {}), ...(input.data.location ? { location: input.data.location } : {}), attendees: input.data.attendees, ...(input.data.notes ? { notes: input.data.notes } : {}) }, include: { candidate: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, organizer: { select: { id: true, name: true } } } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "meeting.created", entityType: "meeting", entityId: created.id, metadata: { candidateId: created.candidateId, jobId: created.jobId, startsAt: created.startsAt.toISOString() } } });
        const deliveries = await persistWebhookEvent(tx, request.organizationId, "meeting.created", { meeting_id: created.id, candidate_id: created.candidateId, job_id: created.jobId, starts_at: created.startsAt.toISOString() });
        return { meeting: created, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(201).send(meeting);
    });

    v1.patch<{ Params: { meetingId: string } }>("/meetings/:meetingId", {
      schema: { tags: ["Meetings"], summary: "Update a meeting or record its outcome" }
    }, async (request) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(), startsAt: z.iso.datetime().optional(), durationMinutes: z.number().int().min(15).max(240).optional(), location: z.string().trim().max(500).nullable().optional(), notes: z.string().max(10_000).nullable().optional() }).refine((value) => Object.keys(value).length > 0).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_meeting_update", "Provide a valid meeting update.", 422);
      const existing = await prisma.meeting.findFirst({ where: { id: request.params.meetingId, organizationId: request.organizationId }, select: { id: true, status: true } });
      if (!existing) throw forbidden("meeting_not_found", "Meeting was not found in this organization.", 404);
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.meeting.update({ where: { id: existing.id }, data: { ...(input.data.status === undefined ? {} : { status: input.data.status }), ...(input.data.startsAt === undefined ? {} : { startsAt: new Date(input.data.startsAt) }), ...(input.data.durationMinutes === undefined ? {} : { durationMinutes: input.data.durationMinutes }), ...(input.data.location === undefined ? {} : { location: input.data.location }), ...(input.data.notes === undefined ? {} : { notes: input.data.notes }) } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "meeting.updated", entityType: "meeting", entityId: changed.id, metadata: { fields: Object.keys(input.data), fromStatus: existing.status, toStatus: changed.status } } });
        return changed;
      });
      return updated;
    });

    v1.get("/pipeline/stages", {
      schema: { tags: ["Pipeline"], summary: "List configured pipeline stages" }
    }, async (request) => {
      requirePermission(request, "candidate.read");
      const data = await prisma.pipelineStage.findMany({
        where: { organizationId: request.organizationId },
        orderBy: { sortOrder: "asc" }
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.post("/pipeline/stages", {
      schema: { tags: ["Pipeline"], summary: "Add a stage to the tenant's hiring pipeline" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ name: z.string().trim().min(2).max(64), color: z.string().regex(/^#[\da-fA-F]{6}$/).default("#9ed9ff"), terminal: z.boolean().default(false) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_pipeline_stage", "Provide a valid stage name and color.", 422);
      const stage = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.organizationId} FOR UPDATE`;
        if (await tx.pipelineStage.count({ where: { organizationId: request.organizationId } }) >= 200) throw forbidden("pipeline_stage_limit", "A workspace can have at most 200 stages.", 409);
        const last = await tx.pipelineStage.findFirst({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
        const created = await tx.pipelineStage.create({ data: { organizationId: request.organizationId, name: input.data.name, color: input.data.color, terminal: input.data.terminal, sortOrder: (last?.sortOrder ?? -1) + 1 } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "pipeline.stage.created", entityType: "pipeline_stage", entityId: created.id } });
        return created;
      });
      return reply.status(201).send(stage);
    });

    v1.patch("/pipeline/stages/order", {
      schema: { tags: ["Pipeline"], summary: "Reorder all stages with stale-order protection" }
    }, async (request) => {
      requirePermission(request, "candidate.manage");
      const ids = z.array(z.string().min(1).max(100)).min(1).max(200).refine((value) => new Set(value).size === value.length);
      const input = z.object({ stageIds: ids, expectedStageIds: ids }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_pipeline_order", "Provide complete, unique stage IDs and the order you last loaded.", 422);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.organizationId} FOR UPDATE`;
        const stages = await tx.pipelineStage.findMany({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "asc" } });
        const previous = stages.map((stage) => stage.id);
        if (previous.length !== input.data.stageIds.length || input.data.stageIds.some((id) => !previous.includes(id))) {
          throw forbidden("invalid_pipeline_order", "The new order must include every stage in this workspace exactly once.", 422);
        }
        if (JSON.stringify(previous) !== JSON.stringify(input.data.expectedStageIds)) {
          throw forbidden("pipeline_order_changed", "The pipeline changed. Reload its stages before reordering.", 409);
        }
        if (JSON.stringify(previous) !== JSON.stringify(input.data.stageIds)) {
          // Vacate positive positions first: the organization/position uniqueness
          // constraint is immediate, so direct swaps would otherwise collide.
          for (let index = 0; index < previous.length; index++) {
            await tx.pipelineStage.update({ where: { id: previous[index]! }, data: { sortOrder: -index - 1 } });
          }
          for (let index = 0; index < input.data.stageIds.length; index++) {
            await tx.pipelineStage.update({ where: { id: input.data.stageIds[index]! }, data: { sortOrder: index } });
          }
          await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "pipeline.stages.reordered", entityType: "organization", entityId: request.organizationId, metadata: { from: previous, to: input.data.stageIds } } });
        }
        const data = await tx.pipelineStage.findMany({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "asc" } });
        return { object: "list", data, has_more: false, total_count: data.length };
      });
    });

    v1.patch<{ Params: { stageId: string } }>("/pipeline/stages/:stageId", {
      schema: { tags: ["Pipeline"], summary: "Rename or configure a pipeline stage" }
    }, async (request) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ name: z.string().trim().min(2).max(64).optional(), color: z.string().regex(/^#[\da-fA-F]{6}$/).optional(), terminal: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_pipeline_stage", "Provide at least one valid stage field.", 422);
      const existing = await prisma.pipelineStage.findFirst({ where: { id: request.params.stageId, organizationId: request.organizationId }, select: { id: true } });
      if (!existing) throw forbidden("pipeline_stage_not_found", "Pipeline stage was not found in this organization.", 404);
      const stage = await prisma.pipelineStage.update({ where: { id: existing.id }, data: {
        ...(input.data.name === undefined ? {} : { name: input.data.name }),
        ...(input.data.color === undefined ? {} : { color: input.data.color }),
        ...(input.data.terminal === undefined ? {} : { terminal: input.data.terminal })
      } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "pipeline.stage.updated", entityType: "pipeline_stage", entityId: stage.id, metadata: { fields: Object.keys(input.data) } } });
      return stage;
    });

    v1.delete<{ Params: { stageId: string } }>("/pipeline/stages/:stageId", {
      schema: { tags: ["Pipeline"], summary: "Delete an unused pipeline stage" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.organizationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "PipelineStage" WHERE "id" = ${request.params.stageId} AND "organizationId" = ${request.organizationId} FOR UPDATE`;
        const existing = await tx.pipelineStage.findFirst({ where: { id: request.params.stageId, organizationId: request.organizationId }, include: { _count: { select: { candidateJobs: true } } } });
        if (!existing) throw forbidden("pipeline_stage_not_found", "Pipeline stage was not found in this organization.", 404);
        if (existing._count.candidateJobs > 0) throw forbidden("pipeline_stage_in_use", "Move candidates to another stage before deleting this one.", 409);
        const stageCount = await tx.pipelineStage.count({ where: { organizationId: request.organizationId } });
        if (stageCount <= 1) throw forbidden("last_pipeline_stage", "A workspace must keep at least one pipeline stage.", 409);
        await tx.pipelineStage.delete({ where: { id: existing.id } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "pipeline.stage.deleted", entityType: "pipeline_stage", entityId: existing.id, metadata: { name: existing.name } } });
      });
      return reply.status(204).send();
    });

    v1.patch<{ Params: { candidateJobId: string } }>("/candidate-jobs/:candidateJobId/stage", {
      schema: { tags: ["Pipeline"], summary: "Move a candidate to another configured stage" }
    }, async (request) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ stageId: z.string().min(1) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_stage", "Choose a configured pipeline stage.", 422);
      const [candidateJob, stage] = await Promise.all([
        prisma.candidateJob.findFirst({
          where: { id: request.params.candidateJobId, candidate: { organizationId: request.organizationId } },
          select: { id: true, candidateId: true, jobId: true, stageId: true }
        }),
        prisma.pipelineStage.findFirst({ where: { id: input.data.stageId, organizationId: request.organizationId }, select: { id: true, name: true } })
      ]);
      if (!candidateJob || !stage) throw forbidden("pipeline_target_not_found", "Candidate or stage was not found in this organization.", 404);
      const { updated, deliveries } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.organizationId} FOR UPDATE`;
      const current = await tx.candidateJob.findUniqueOrThrow({ where: { id: candidateJob.id } });
      const target = await tx.pipelineStage.findFirst({ where: { id: stage.id, organizationId: request.organizationId } });
      if (!target) throw forbidden("pipeline_target_not_found", "The stage is no longer available.", 404);
      if (current.stageId === stage.id) return { updated: await tx.candidateJob.findUniqueOrThrow({ where: { id: current.id }, include: { candidate: { select: { name: true } }, job: { select: { title: true } }, stage: { select: { id: true, name: true } } } }), deliveries: [] as string[] };
      const updated = await tx.candidateJob.update({
        where: { id: candidateJob.id },
        data: { stageId: stage.id },
        include: { candidate: { select: { name: true } }, job: { select: { title: true } }, stage: { select: { id: true, name: true } } }
      });
      await tx.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "pipeline.stage.changed",
          entityType: "candidate_job",
          entityId: updated.id,
          metadata: { fromStageId: current.stageId, toStageId: stage.id, jobId: candidateJob.jobId }
        }
      });
      const deliveries = await persistWebhookEvent(tx, request.organizationId, "candidate_job.stage_changed", { candidate_job_id: updated.id, candidate_id: candidateJob.candidateId, job_id: candidateJob.jobId, from_stage_id: current.stageId, to_stage_id: stage.id });
      return { updated, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return updated;
    });

    v1.post("/candidate-jobs", {
      schema: { tags: ["Pipeline"], summary: "Connect a candidate to a job at its first pipeline stage" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ candidateId: z.string().min(1), jobId: z.string().min(1) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_pipeline_assignment", "Candidate and job are required.", 422);
      const [candidate, job, firstStage] = await Promise.all([
        prisma.candidate.findFirst({ where: { id: input.data.candidateId, organizationId: request.organizationId }, select: { id: true } }),
        prisma.job.findFirst({ where: { id: input.data.jobId, organizationId: request.organizationId }, select: { id: true, status: true } }),
        prisma.pipelineStage.findFirst({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "asc" }, select: { id: true } })
      ]);
      if (!candidate || !job || !firstStage) throw forbidden("pipeline_target_not_found", "Candidate, job, or pipeline stage was not found in this organization.", 404);
      const { assignment, deliveries } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.organizationId} FOR UPDATE`;
      const currentFirst = await tx.pipelineStage.findFirst({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      if (!currentFirst) throw forbidden("pipeline_target_not_found", "The pipeline has no available stage.", 409);
      const assignment = await tx.candidateJob.create({
        data: { candidateId: candidate.id, jobId: job.id, stageId: currentFirst.id },
        include: { candidate: { select: { name: true } }, job: { select: { title: true } }, stage: { select: { id: true, name: true } } }
      });
      await tx.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "pipeline.candidate.added",
          entityType: "candidate_job",
          entityId: assignment.id,
          metadata: { candidateId: candidate.id, jobId: job.id, stageId: currentFirst.id }
        }
      });
      const deliveries = await persistWebhookEvent(tx, request.organizationId, "candidate_job.created", { candidate_job_id: assignment.id, candidate_id: candidate.id, job_id: job.id, stage_id: currentFirst.id });
      return { assignment, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(201).send(assignment);
    });

    v1.post("/candidates", {
      schema: { tags: ["Candidates"], summary: "Add a candidate to the talent pool" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ name: z.string().trim().min(2).max(120), email: z.email(), phone: z.string().trim().max(40).optional(), headline: z.string().trim().max(180).optional(), source: z.string().trim().max(40).default("MANUAL") }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_candidate", "Candidate details are invalid.", 422);
      const { created, deliveries } = await prisma.$transaction(async (tx) => {
        const created = await tx.candidate.create({ data: { organizationId: request.organizationId, name: input.data.name, email: input.data.email.toLowerCase(), phone: input.data.phone ?? null, headline: input.data.headline ?? null, source: input.data.source } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "candidate.created", entityType: "candidate", entityId: created.id } });
        const deliveries = await persistWebhookEvent(tx, request.organizationId, "candidate.created", { candidate_id: created.id, source: created.source });
        return { created, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(201).send(created);
    });

    v1.post("/assessments", {
      schema: { tags: ["Assessments"], summary: "Create an assessment and secure candidate launch link" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      if (production) throw forbidden("assessment_provider_unavailable", "Assessment invitations are disabled until a reviewed production provider is configured.", 503);
      const idempotencyKey = z.string().min(8).max(200).safeParse(request.headers["idempotency-key"]);
      if (!idempotencyKey.success) throw forbidden("idempotency_key_required", "Provide an Idempotency-Key header with every create request.", 400);
      const input = z.object({ candidateId: z.string().min(1), roundId: z.string().min(1), expiresInHours: z.number().int().min(1).max(168).default(72) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_assessment", "Assessment details are invalid.", 422);

      const result = await prisma.$transaction((tx) => createAssessmentInvitation(tx, { organizationId: request.organizationId, userId: request.currentUserId }, input.data, idempotencyKey.data));
      if (result.replayed) return reply.header("Idempotent-Replay", "true").send(result);
      return reply.status(201).send(result);
    });

    v1.get("/assessments", {
      schema: { tags: ["Assessments"], summary: "List assessment outcomes in the active organization" }
    }, async (request) => {
      requirePermission(request, "report.read");
      const rows = await prisma.assessment.findMany({
        where: { candidate: { organizationId: request.organizationId } },
        select: {
          id: true,
          status: true,
          score: true,
          summary: true,
          createdAt: true,
          completedAt: true,
          configuration: true,
          candidate: { select: { id: true, name: true, email: true } },
          round: { include: { job: { include: { requirements: true } } } }
        },
        orderBy: { createdAt: "desc" },
        take: 100
      });
      const data = rows.map((row) => {
        const configuration = resolveAssessmentConfiguration(row);
        const { configuration: _stored, round: _liveRound, ...assessment } = row;
        return { ...assessment, round: { id: configuration.round.id, title: configuration.round.title, type: configuration.round.type, job: { id: configuration.job.id, title: configuration.job.title } } };
      });
      return { object: "list", data, has_more: false, total_count: data.length };
    });

    v1.get("/analytics/summary", {
      schema: { tags: ["Analytics"], summary: "Get tenant-scoped recruiting activity totals" }
    }, async (request) => {
      requirePermission(request, "report.read");
      const assessmentWhere = { candidate: { organizationId: request.organizationId } };
      const [candidateCount, openJobCount, assessmentCount, completedAssessmentCount, clientsCount, stageGroups] = await Promise.all([
        prisma.candidate.count({ where: { organizationId: request.organizationId } }),
        prisma.job.count({ where: { organizationId: request.organizationId, status: "OPEN" } }),
        prisma.assessment.count({ where: assessmentWhere }),
        prisma.assessment.count({ where: { ...assessmentWhere, status: "COMPLETED" } }),
        prisma.client.count({ where: { organizationId: request.organizationId } }),
        prisma.candidateJob.groupBy({ by: ["stageId"], where: { candidate: { organizationId: request.organizationId }, status: "ACTIVE" }, _count: { _all: true } })
      ]);
      const stageIds = stageGroups.flatMap((item) => item.stageId ? [item.stageId] : []);
      const stages = stageIds.length ? await prisma.pipelineStage.findMany({ where: { organizationId: request.organizationId, id: { in: stageIds } }, select: { id: true, name: true, sortOrder: true } }) : [];
      const stageNames = new Map(stages.map((stage) => [stage.id, stage]));
      const funnel = stageGroups.map((item) => ({ stage: item.stageId ? stageNames.get(item.stageId)?.name ?? "Unassigned" : "Unassigned", count: item._count._all, sortOrder: item.stageId ? stageNames.get(item.stageId)?.sortOrder ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER })).sort((a, b) => a.sortOrder - b.sortOrder).map(({ stage, count }) => ({ stage, count }));
      return { generatedAt: new Date().toISOString(), candidates: candidateCount, openJobs: openJobCount, assessments: assessmentCount, completedAssessments: completedAssessmentCount, assessmentCompletionRate: assessmentCount ? Math.round(completedAssessmentCount / assessmentCount * 100) : 0, clients: clientsCount, pipeline: funnel };
    });

    v1.get<{ Params: { assessmentId: string } }>("/assessments/:assessmentId", {
      schema: { tags: ["Assessments"], summary: "Get an evidence-backed assessment report" }
    }, async (request) => {
      requirePermission(request, "report.read");
      const assessment = await prisma.assessment.findFirst({
        where: { id: request.params.assessmentId, candidate: { organizationId: request.organizationId } },
        select: {
          id: true,
          status: true,
          score: true,
          summary: true,
          consentedAt: true,
          startedAt: true,
          completedAt: true,
          submission: true,
          transcript: true,
          configuration: true,
          candidate: { select: { id: true, name: true, email: true, headline: true } },
          round: {
            select: {
              id: true,
              title: true,
              type: true,
              durationMinutes: true,
              proctoringEnabled: true,
              desktopRequired: true,
              difficulty: true,
              promotionScore: true,
              rejectionScore: true,
              questions: true,
              job: { select: { id: true, title: true, description: true, requirements: { orderBy: { sortOrder: "asc" } } } }
            }
          },
          evidence: { orderBy: { weight: "desc" } },
          integrityEvents: { orderBy: { occurredAt: "asc" } }
        }
      });
      if (!assessment) throw forbidden("assessment_not_found", "Assessment report was not found in this organization.", 404);
      const configuration = resolveAssessmentConfiguration(assessment);
      return { assessment: { ...assessment, round: { ...assessment.round, ...configuration.round, job: { ...assessment.round.job, ...configuration.job } } }, configurationSource: assessment.configuration ? "invitation_snapshot" : "legacy_current", advisoryOnly: true };
    });

    v1.post("/jobs", {
      schema: { tags: ["Jobs"], summary: "Create a scored job" }
    }, async (request, reply) => {
      requirePermission(request, "job.create");
      const input = jobSchema.safeParse(request.body);
      if (!input.success) {
        return reply.status(422).send({
          error: {
            type: "validation_error",
            code: "invalid_job",
            message: "The job needs a title, a detailed description, and at least one weighted requirement.",
            request_id: request.id,
            fields: z.treeifyError(input.error)
          }
        });
      }

      const job = await prisma.$transaction(async (tx) => {
        const created = await tx.job.create({
          data: {
            organizationId: request.organizationId,
            title: input.data.title,
            location: input.data.location ?? null,
            description: input.data.description,
            language: input.data.language,
            workflowEnabled: input.data.workflowEnabled,
            requirements: {
              create: input.data.requirements.map((requirement, index) => ({ ...requirement, sortOrder: index }))
            }
          },
          include: { requirements: true }
        });
        await tx.auditEvent.create({
          data: {
            organizationId: request.organizationId,
            action: "job.created",
            entityType: "job",
            entityId: created.id,
            metadata: { title: created.title }
          }
        });
        return created;
      });

      return reply.status(201).send(job);
    });

    v1.patch<{ Params: { jobId: string; roundId: string } }>("/jobs/:jobId/rounds/:roundId/retirement", {
      schema: { tags: ["Jobs"], summary: "Retire or restore a round while preserving existing assessments" }
    }, async (request) => {
      requirePermission(request, "job.manage");
      const input = z.object({ retired: z.boolean(), expectedRetired: z.boolean() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_round_retirement", "Specify retired and expectedRetired states.", 422);
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "Round" r JOIN "Job" j ON j."id" = r."jobId"
          WHERE r."id" = ${request.params.roundId} AND r."jobId" = ${request.params.jobId}
            AND j."organizationId" = ${request.organizationId} FOR UPDATE OF r`;
        if (!locked.length) throw forbidden("round_not_found", "Assessment round was not found in this organization.", 404);
        const current = await tx.round.findUniqueOrThrow({ where: { id: request.params.roundId } });
        if (!!current.retiredAt !== input.data.expectedRetired) throw forbidden("round_retirement_conflict", "This round's state has changed. Reload it before continuing.", 409);
        if (!!current.retiredAt === input.data.retired) return current;
        const updated = await tx.round.update({ where: { id: current.id }, data: { retiredAt: input.data.retired ? new Date() : null } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: input.data.retired ? "job.round.retired" : "job.round.restored", entityType: "round", entityId: current.id, metadata: { jobId: request.params.jobId } } });
        return updated;
      });
    });

    v1.delete<{ Params: { jobId: string; roundId: string } }>("/jobs/:jobId/rounds/:roundId", {
      schema: { tags: ["Jobs"], summary: "Remove an unused assessment round without deleting assessment history" }
    }, async (request, reply) => {
      requirePermission(request, "job.manage");
      await prisma.$transaction(async (tx) => {
        // Assessment inserts acquire a shared FK lock on Round. Hold an exclusive
        // lock before checking usage so concurrent invitations cannot be cascaded away.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "Round" r JOIN "Job" j ON j."id" = r."jobId"
          WHERE r."id" = ${request.params.roundId} AND r."jobId" = ${request.params.jobId}
            AND j."organizationId" = ${request.organizationId} FOR UPDATE OF r`;
        if (!locked.length) throw forbidden("round_not_found", "Assessment round was not found in this organization.", 404);
        if (await tx.assessment.count({ where: { roundId: request.params.roundId } })) {
          throw forbidden("round_in_use", "Rounds with assessment history cannot be removed.", 409);
        }
        await tx.round.delete({ where: { id: request.params.roundId } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "job.round.deleted", entityType: "round", entityId: request.params.roundId, metadata: { jobId: request.params.jobId } } });
      });
      return reply.status(204).send();
    });

    v1.patch<{ Params: { jobId: string } }>("/jobs/:jobId", {
      schema: { tags: ["Jobs"], summary: "Update a role, rubric, workflow, or assessment plan" }
    }, async (request) => {
      requirePermission(request, "job.manage");
      const roundSchema = z.object({
        title: z.string().trim().min(2).max(120),
        type: z.enum(["RESUME_SCREEN", "AI_INTERVIEW", "HUMAN_INTERVIEW", "CODING_TEST", "PROMPT_ASSESSMENT"]),
        sequence: z.number().int().min(1).max(20),
        durationMinutes: z.number().int().min(0).max(240).default(20),
        difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
        proctoringEnabled: z.boolean().default(false),
        desktopRequired: z.boolean().default(false),
        promotionScore: z.number().int().min(0).max(100).nullable().default(null),
        rejectionScore: z.number().int().min(0).max(100).nullable().default(null),
        questions: z.array(z.object({ id: z.string().min(1), label: z.string().trim().min(4).max(1000) })).max(30).default([])
      });
      const input = z.object({
        title: z.string().trim().min(2).max(120).optional(),
        location: z.string().trim().max(120).nullable().optional(),
        description: z.string().trim().min(100).max(20_000).optional(),
        status: z.enum(["DRAFT", "OPEN", "PAUSED", "CLOSED"]).optional(),
        workflowEnabled: z.boolean().optional(),
        requirements: z.array(z.object({ name: z.string().trim().min(2).max(120), weight: z.number().int().min(1).max(100) })).min(1).max(20).optional(),
        rounds: z.array(roundSchema).max(20).optional()
      }).refine((value) => Object.keys(value).length > 0)
        .refine((value) => !value.requirements || value.requirements.reduce((sum, item) => sum + item.weight, 0) === 100)
        .refine((value) => !value.rounds || new Set(value.rounds.map((round) => round.sequence)).size === value.rounds.length)
        .safeParse(request.body);
      if (!input.success) throw forbidden("invalid_job_update", "Role details, rubric, or assessment plan are invalid.", 422);
      const existing = await prisma.job.findFirst({ where: { id: request.params.jobId, organizationId: request.organizationId }, select: { id: true } });
      if (!existing) throw forbidden("job_not_found", "Role was not found in this organization.", 404);

      const job = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${existing.id} FOR UPDATE`;
        if (input.data.requirements) await tx.requirement.deleteMany({ where: { jobId: existing.id } });
        const updated = await tx.job.update({ where: { id: existing.id }, data: {
          ...(input.data.title === undefined ? {} : { title: input.data.title }),
          ...(input.data.location === undefined ? {} : { location: input.data.location }),
          ...(input.data.description === undefined ? {} : { description: input.data.description }),
          ...(input.data.status === undefined ? {} : { status: input.data.status }),
          ...(input.data.workflowEnabled === undefined ? {} : { workflowEnabled: input.data.workflowEnabled }),
          ...(input.data.requirements === undefined ? {} : { requirements: { create: input.data.requirements.map((requirement, index) => ({ ...requirement, sortOrder: index })) } })
        } });
        if (input.data.rounds) {
          for (const round of input.data.rounds) {
            await tx.round.upsert({
              where: { jobId_sequence: { jobId: existing.id, sequence: round.sequence } },
              create: { jobId: existing.id, ...round },
              update: {
                title: round.title,
                type: round.type,
                durationMinutes: round.durationMinutes,
                difficulty: round.difficulty,
                proctoringEnabled: round.proctoringEnabled,
                desktopRequired: round.desktopRequired,
                promotionScore: round.promotionScore,
                rejectionScore: round.rejectionScore,
                questions: round.questions
              }
            });
          }
        }
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "job.updated", entityType: "job", entityId: updated.id, metadata: { fields: Object.keys(input.data) } } });
        return tx.job.findUniqueOrThrow({ where: { id: updated.id }, include: { requirements: { orderBy: { sortOrder: "asc" } }, rounds: { orderBy: { sequence: "asc" } } } });
      });
      return job;
    });
  }, { prefix: "/v1" });

  app.register(async (publicApi) => {
    publicApi.addHook("preHandler", async (request) => {
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!/^nsk_(test|live)_[A-Za-z0-9_-]{43}$/.test(token)) throw forbidden("api_key_invalid", "A valid API key is required.", 401);
      const key = await prisma.apiKey.findFirst({ where: { keyHash: tokenHash(token), prefix: token.slice(0, 18), revokedAt: null }, select: { id: true, organizationId: true, environment: true, scopes: true } });
      if (!key || !token.startsWith(`nsk_${key.environment}_`)) throw forbidden("api_key_invalid", "A valid API key is required.", 401);
      request.apiKeyOrganizationId = key.organizationId;
      request.apiKeyScopes = key.scopes;
      request.apiKeyId = key.id;
      await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    });

    publicApi.get("/jobs", { schema: { tags: ["Public API"], summary: "List published jobs using a scoped API key" } }, async (request) => {
      requireApiKeyScope(request, "jobs:read");
      const input = publicPaginationSchema.safeParse(request.query);
      if (!input.success) throw forbidden("invalid_pagination", "Use a limit from 1 to 100 and a valid cursor.", 422);
      const scope = { organizationId: request.apiKeyOrganizationId, status: "OPEN" as const };
      const cursor = input.data.cursor ? await prisma.job.findFirst({ where: { ...scope, id: input.data.cursor }, select: { id: true, createdAt: true } }) : null;
      if (input.data.cursor && !cursor) throw forbidden("invalid_cursor", "Cursor is not available in this list. Restart pagination.", 422);
      const [data, total] = await Promise.all([
        prisma.job.findMany({ where: { ...scope, ...afterPublicCursor(cursor) }, select: { id: true, title: true, location: true, description: true, currency: true, salaryMin: true, salaryMax: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: input.data.limit + 1 }),
        prisma.job.count({ where: scope })
      ]);
      return publicPage(data, input.data.limit, total);
    });

    publicApi.get("/candidates", { schema: { tags: ["Public API"], summary: "List candidates visible to a scoped API key" } }, async (request) => {
      requireApiKeyScope(request, "candidates:read");
      const input = publicPaginationSchema.safeParse(request.query);
      if (!input.success) throw forbidden("invalid_pagination", "Use a limit from 1 to 100 and a valid cursor.", 422);
      const scope = { organizationId: request.apiKeyOrganizationId };
      const cursor = input.data.cursor ? await prisma.candidate.findFirst({ where: { ...scope, id: input.data.cursor }, select: { id: true, createdAt: true } }) : null;
      if (input.data.cursor && !cursor) throw forbidden("invalid_cursor", "Cursor is not available in this list. Restart pagination.", 422);
      const [data, total] = await Promise.all([
        prisma.candidate.findMany({ where: { ...scope, ...afterPublicCursor(cursor) }, select: { id: true, name: true, email: true, headline: true, source: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: input.data.limit + 1 }),
        prisma.candidate.count({ where: scope })
      ]);
      return publicPage(data, input.data.limit, total);
    });

    publicApi.post("/candidates", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { tags: ["Public API"], summary: "Create a candidate using a scoped API key" } }, async (request, reply) => {
      requireApiKeyScope(request, "candidates:write");
      const input = z.object({ name: z.string().trim().min(2).max(160), email: z.email(), headline: z.string().trim().max(250).optional(), source: z.string().trim().max(80).default("API") }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_candidate", "Candidate details are invalid.", 422);
      const email = input.data.email.toLowerCase();
      const { candidate, created, deliveries } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${request.apiKeyOrganizationId} FOR UPDATE`;
        const existing = await tx.candidate.findUnique({ where: { organizationId_email: { organizationId: request.apiKeyOrganizationId, email } } });
        const candidate = await tx.candidate.upsert({
          where: { organizationId_email: { organizationId: request.apiKeyOrganizationId, email } },
          create: { organizationId: request.apiKeyOrganizationId, name: input.data.name, email, source: input.data.source, ...(input.data.headline === undefined ? {} : { headline: input.data.headline }) },
          update: { name: input.data.name, ...(input.data.headline === undefined ? {} : { headline: input.data.headline }) }
        });
        const fields = existing ? [existing.name !== candidate.name ? "name" : null, existing.headline !== candidate.headline ? "headline" : null].filter((field): field is string => field !== null) : [];
        await tx.auditEvent.create({ data: { organizationId: request.apiKeyOrganizationId, action: "candidate.upserted.via_api_key", entityType: "candidate", entityId: candidate.id, metadata: { apiKeyId: request.apiKeyId, source: candidate.source, created: !existing, changedFields: fields } } });
        const deliveries = !existing || fields.length ? await persistWebhookEvent(tx, request.apiKeyOrganizationId, existing ? "candidate.updated" : "candidate.created", { candidate_id: candidate.id, source: candidate.source, ...(existing ? { changed_fields: fields } : {}) }) : [];
        return { candidate, created: !existing, deliveries };
      });
      await queueWebhookDeliveries(deliveries);
      return reply.status(created ? 201 : 200).send({ id: candidate.id, name: candidate.name, email: candidate.email, headline: candidate.headline, createdAt: candidate.createdAt });
    });
  }, { prefix: "/public/v1" });

  app.addHook("onClose", async () => {
    if (assessmentQueue) await assessmentQueue.close();
    if (webhookQueue) await webhookQueue.close();
    assessmentQueue = null;
    webhookQueue = null;
  });

  return app;
}
