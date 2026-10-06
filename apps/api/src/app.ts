import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { prisma } from "@northstar/database";
import { applyCreditMovement, canTransitionAssessment, checkPlacementEligibility, creditCosts, hasPermission, jobSchema, type AssessmentType, type Permission, type Role } from "@northstar/domain";
import { LocalBillingProvider, LocalEvaluationProvider } from "@northstar/providers";
import { Queue, type ConnectionOptions } from "bullmq";
import { compare } from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { createSessionToken, readSessionToken } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    organizationId: string;
    currentUserId: string;
    membershipRole: Role;
  }
}

const organizationHeader = z.string().min(1);
const localEvaluator = new LocalEvaluationProvider();
const localBilling = new LocalBillingProvider();
let assessmentQueue: Queue | null = null;

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

function getAssessmentQueue() {
  assessmentQueue ??= new Queue("assessment-processing", { connection: redisConnection() });
  return assessmentQueue;
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

function assertSameOriginForStateChanges(request: FastifyRequest, allowedOrigins: ReadonlySet<string>) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.origin;
  if (request.headers["sec-fetch-site"] === "cross-site" || (origin && !allowedOrigins.has(origin))) {
    throw forbidden("cross_origin_request", "Cross-origin state changes are not allowed.", 403);
  }
}

export async function buildApp() {
  const production = process.env.NODE_ENV === "production";
  const configuredSessionSecret = process.env.SESSION_SECRET;
  const webUrl = process.env.WEB_URL;
  if (production && (!configuredSessionSecret || configuredSessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters in production");
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

  app.get("/ready", {
    schema: { tags: ["System"], summary: "Database readiness check" }
  }, async (_request, reply) => {
    await prisma.$queryRaw`SELECT 1`;
    return reply.send({ status: "ready" });
  });

  app.register(async (candidate) => {
    async function findAssessment(rawToken: string) {
      return prisma.assessment.findUnique({
        where: { launchTokenHash: tokenHash(rawToken) },
        include: {
          candidate: { select: { id: true, name: true } },
          round: { include: { job: { include: { requirements: true } } } },
          evidence: true,
          integrityEvents: true
        }
      });
    }

    candidate.get<{ Params: { token: string } }>("/:token", {
      schema: { tags: ["Candidate session"], summary: "Resolve a secure candidate launch token" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      if (!assessment || !assessment.launchExpiresAt || assessment.launchExpiresAt < new Date()) {
        throw forbidden("launch_token_invalid", "This assessment link is invalid or has expired.", 401);
      }
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
          questions: assessment.round.questions
        }
      };
    });

    candidate.post<{ Params: { token: string } }>("/:token/consent", {
      schema: { tags: ["Candidate session"], summary: "Record candidate consent" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      if (!assessment || !assessment.launchExpiresAt || assessment.launchExpiresAt < new Date()) throw forbidden("launch_token_invalid", "This assessment link is invalid or has expired.", 401);
      if (!["PENDING", "SCHEDULED"].includes(assessment.status)) throw forbidden("assessment_not_available", "This assessment is no longer accepting consent.", 409);
      return prisma.assessment.update({ where: { id: assessment.id }, data: { consentedAt: new Date(), status: "SCHEDULED" }, select: { id: true, status: true, consentedAt: true } });
    });

    candidate.post<{ Params: { token: string } }>("/:token/start", {
      schema: { tags: ["Candidate session"], summary: "Start a consented assessment" }
    }, async (request) => {
      const assessment = await findAssessment(request.params.token);
      if (!assessment || !assessment.launchExpiresAt || assessment.launchExpiresAt < new Date()) throw forbidden("launch_token_invalid", "This assessment link is invalid or has expired.", 401);
      if (!assessment.consentedAt) throw forbidden("consent_required", "Consent is required before this assessment can start.", 409);
      if (!canTransitionAssessment(assessment.status, "IN_PROGRESS")) throw forbidden("invalid_assessment_state", "This assessment cannot be started from its current state.", 409);
      return prisma.assessment.update({ where: { id: assessment.id }, data: { status: "IN_PROGRESS", startedAt: new Date() }, select: { id: true, status: true, startedAt: true } });
    });

    candidate.post<{ Params: { token: string } }>("/:token/integrity-events", {
      schema: { tags: ["Candidate session"], summary: "Append advisory browser integrity context" }
    }, async (request) => {
      const input = z.object({ type: z.enum(["FOCUS_CHANGE", "CAMERA_UNAVAILABLE", "RECONNECT"]), detail: z.record(z.string(), z.unknown()).default({}) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_integrity_event", "Integrity event is invalid.", 422);
      const assessment = await findAssessment(request.params.token);
      if (!assessment || assessment.status !== "IN_PROGRESS") throw forbidden("assessment_not_in_progress", "Integrity context can only be recorded during an active assessment.", 409);
      return prisma.integrityEvent.create({ data: { assessmentId: assessment.id, type: input.data.type, severity: "INFO", detail: { ...input.data.detail, advisoryOnly: true } }, select: { id: true, type: true, occurredAt: true } });
    });

    candidate.post<{ Params: { token: string } }>("/:token/submit", {
      schema: { tags: ["Candidate session"], summary: "Submit and evaluate an active assessment" }
    }, async (request, reply) => {
      const input = z.object({ response: z.string().trim().min(20).max(50_000), answers: z.record(z.string(), z.string()).optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_submission", "A meaningful response is required.", 422);
      if (process.env.NODE_ENV === "production") throw forbidden("assessment_provider_unavailable", "Assessment evaluation is disabled until a reviewed production provider is configured.", 503);
      const assessment = await findAssessment(request.params.token);
      if (!assessment || assessment.status !== "IN_PROGRESS") throw forbidden("assessment_not_in_progress", "This assessment is not accepting a submission.", 409);

      await prisma.assessment.update({ where: { id: assessment.id }, data: { status: "PROCESSING", submission: input.data.answers ?? { response: input.data.response } } });
      if (process.env.ASSESSMENT_PROCESSING_MODE === "queue") {
        try {
          await getAssessmentQueue().add("evaluate", { assessmentId: assessment.id, response: input.data.response, answers: input.data.answers }, {
            jobId: assessment.id,
            attempts: 3,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000
          });
        } catch (error) {
          await prisma.assessment.update({ where: { id: assessment.id }, data: { status: "FAILED" } });
          throw error;
        }
        return reply.status(202).send({ assessment: { id: assessment.id, status: "PROCESSING" }, processing: "queued", advisoryOnly: true });
      }
      try {
        const result = await localEvaluator.evaluate({
          assessmentId: assessment.id,
          jobDescription: assessment.round.job.description,
          response: input.data.response,
          criteria: assessment.round.job.requirements.map((criterion) => ({ name: criterion.name, weight: criterion.weight }))
        });
        const completed = await prisma.assessment.update({
          where: { id: assessment.id },
          data: {
            status: "COMPLETED",
            score: result.overallScore,
            summary: result.summary,
            completedAt: new Date(),
            launchTokenHash: null,
            evidence: { create: result.evidence.map((item) => ({ criterion: item.name, score: item.score, weight: item.weight, rationale: item.rationale, evidence: item.evidence })) }
          },
          include: { evidence: true }
        });
        return { assessment: completed, advisoryOnly: true };
      } catch (error) {
        await prisma.assessment.update({ where: { id: assessment.id }, data: { status: "FAILED" } });
        throw error;
      }
    });
  }, { prefix: "/candidate/assessments" });

  app.register(async (auth) => {
    auth.addHook("preHandler", async (request) => assertSameOriginForStateChanges(request, allowedBrowserOrigins));
    const loginSchema = z.object({ email: z.email(), password: z.string().min(8) });

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
      return { profile: { name: profile.user.name, registrationNo: profile.registrationNo, branch: profile.branch, graduationYear: profile.graduationYear }, readiness, attempts, levels };
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
      const student = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, include: { applications: { include: { offer: true } } } });
      if (!student) throw forbidden("student_profile_not_found", "No student profile is linked to this account.", 404);
      const drives = await prisma.placementDrive.findMany({
        where: { season: { organizationId: request.organizationId }, status: "PUBLISHED", applyBy: { gte: new Date() } },
        include: { company: { select: { name: true } }, season: { select: { offerCap: true, upgradeMultiple: true } } },
        orderBy: { applyBy: "asc" }
      });
      const accepted = student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status)));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, null);
      return { object: "list", data: drives.map((drive) => ({
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
      })) };
    });

    v1.post("/student/applications", {
      schema: { tags: ["Student placement"], summary: "Apply the signed-in student to an eligible published drive" }
    }, async (request, reply) => {
      if (request.membershipRole !== "STUDENT") throw forbidden("student_account_required", "Only a student can submit a self-service application.");
      const input = z.object({ driveId: z.string().min(1) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_application", "Select a placement drive.", 422);
      const student = await prisma.studentProfile.findFirst({ where: { userId: request.currentUserId, organizationId: request.organizationId }, include: { applications: { include: { offer: true } } } });
      const drive = await prisma.placementDrive.findFirst({ where: { id: input.data.driveId, season: { organizationId: request.organizationId } }, include: { season: true } });
      if (!student || !drive) throw forbidden("placement_target_not_found", "Student profile or drive was not found in this university.", 404);
      if (drive.status !== "PUBLISHED" || drive.applyBy < new Date()) throw forbidden("drive_closed", "This drive is not accepting applications.", 409);
      if (student.applications.some((application) => application.driveId === drive.id)) throw forbidden("already_applied", "You already applied to this drive.", 409);
      const applicationsCount = await prisma.application.count({ where: { driveId: drive.id, status: { notIn: ["REJECTED", "WITHDRAWN"] } } });
      if (applicationsCount >= drive.openings) throw forbidden("drive_full", "All available openings for this drive have been filled.", 409);
      const accepted = student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status)));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, null);
      const eligibility = checkPlacementEligibility(
        { branch: student.branch, cgpa: student.cgpa === null ? null : Number(student.cgpa), blacklisted: student.blacklisted, placed: student.placed, acceptedOffers: accepted.length, currentCtc },
        { eligibleBranches: drive.eligibleBranches, minCgpa: drive.minCgpa === null ? null : Number(drive.minCgpa), allowPlaced: drive.allowPlaced, ctcMax: drive.ctcMax === null ? null : Number(drive.ctcMax) },
        { offerCap: drive.season.offerCap, upgradeMultiple: drive.season.upgradeMultiple === null ? null : Number(drive.season.upgradeMultiple) }
      );
      if (!eligibility.eligible) throw forbidden("student_ineligible", eligibility.reasons.join("; "), 409);
      const application = await prisma.application.create({ data: { driveId: drive.id, studentId: student.id }, select: { id: true, status: true, appliedAt: true } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "student.placement.application.created", entityType: "application", entityId: application.id, metadata: { driveId: drive.id } } });
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

    v1.get<{ Params: { driveId: string; studentId: string } }>("/placements/drives/:driveId/eligibility/:studentId", {
      schema: { tags: ["Placements"], summary: "Explain a student's placement-drive eligibility" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const [drive, student] = await Promise.all([
        prisma.placementDrive.findFirst({ where: { id: request.params.driveId, season: { organizationId: request.organizationId } }, include: { season: true } }),
        prisma.studentProfile.findFirst({ where: { id: request.params.studentId, organizationId: request.organizationId }, include: { applications: { include: { offer: true } } } })
      ]);
      if (!drive || !student) throw forbidden("placement_target_not_found", "Drive or student was not found in this university.", 404);
      const accepted = student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status)));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, null);
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
        prisma.studentProfile.findFirst({ where: { id: input.data.studentId, organizationId: request.organizationId }, include: { applications: { include: { offer: true } } } })
      ]);
      if (!drive || !student) throw forbidden("placement_target_not_found", "Drive or student was not found in this university.", 404);
      if (drive.status !== "PUBLISHED") throw forbidden("drive_not_open", "Only published placement drives accept applications.", 409);
      if (drive.applyBy < new Date()) throw forbidden("drive_closed", "The application deadline has passed.", 409);
      const accepted = student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status) || (application.offer && ["ACCEPTED", "JOINED"].includes(application.offer.status)));
      const currentCtc = accepted.reduce<number | null>((highest, application) => {
        const value = application.offer ? Number(application.offer.ctc) : null;
        return value === null ? highest : highest === null ? value : Math.max(highest, value);
      }, null);
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
      const application = await prisma.application.create({ data: { driveId: drive.id, studentId: student.id }, include: { drive: { select: { title: true } }, student: { select: { id: true, registrationNo: true, branch: true } } } });
      await prisma.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "placement.application.created",
          entityType: "application",
          entityId: application.id,
          metadata: { driveId: drive.id, studentId: student.id }
        }
      });
      return reply.status(201).send(application);
    });

    v1.patch<{ Params: { applicationId: string } }>("/placements/applications/:applicationId", {
      schema: { tags: ["Placements"], summary: "Advance or close a university application" }
    }, async (request) => {
      requirePermission(request, "university.manage");
      const input = z.object({ status: z.enum(["SHORTLISTED", "INTERVIEWING", "REJECTED", "WITHDRAWN"]) }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_application_status", "Choose a valid review status.", 422);
      const application = await prisma.application.findFirst({ where: { id: request.params.applicationId, drive: { season: { organizationId: request.organizationId } } }, select: { id: true, status: true, driveId: true } });
      if (!application) throw forbidden("application_not_found", "Application was not found in this university.", 404);
      const allowed: Record<string, readonly string[]> = { APPLIED: ["SHORTLISTED", "REJECTED", "WITHDRAWN"], SHORTLISTED: ["INTERVIEWING", "REJECTED", "WITHDRAWN"], INTERVIEWING: ["REJECTED", "WITHDRAWN"] };
      if (!allowed[application.status]?.includes(input.data.status)) throw forbidden("invalid_application_transition", `Application cannot move from ${application.status} to ${input.data.status}.`, 409);
      const updated = await prisma.application.update({ where: { id: application.id }, data: { status: input.data.status } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.application.status.changed", entityType: "application", entityId: application.id, metadata: { from: application.status, to: updated.status, driveId: application.driveId } } });
      return updated;
    });

    v1.post("/placements/offers", {
      schema: { tags: ["Placements"], summary: "Issue a formal offer to an interviewed applicant" }
    }, async (request, reply) => {
      requirePermission(request, "university.manage");
      const input = z.object({ applicationId: z.string().min(1), ctc: z.number().positive().max(1_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/).default("INR"), joiningDate: z.iso.datetime().optional() }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_offer", "Offer amount, currency, or joining date is invalid.", 422);
      const application = await prisma.application.findFirst({ where: { id: input.data.applicationId, drive: { season: { organizationId: request.organizationId } } }, include: { offer: true, student: { select: { id: true } } } });
      if (!application) throw forbidden("application_not_found", "Application was not found in this university.", 404);
      if (application.status !== "INTERVIEWING") throw forbidden("application_not_ready_for_offer", "Move the application to Interviewing before issuing an offer.", 409);
      if (application.offer) throw forbidden("offer_already_exists", "An offer already exists for this application.", 409);
      const offer = await prisma.$transaction(async (tx) => {
        const created = await tx.offer.create({ data: { applicationId: application.id, ctc: input.data.ctc, currency: input.data.currency, joiningDate: input.data.joiningDate ? new Date(input.data.joiningDate) : null } });
        await tx.application.update({ where: { id: application.id }, data: { status: "OFFERED" } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.offer.created", entityType: "offer", entityId: created.id, metadata: { applicationId: application.id, ctc: input.data.ctc, currency: input.data.currency } } });
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
      const offer = await prisma.offer.findFirst({ where: { id: request.params.offerId, application: { drive: { season: { organizationId: request.organizationId } } } }, include: { application: { select: { id: true, studentId: true, status: true } } } });
      if (!offer) throw forbidden("offer_not_found", "Offer was not found in this university.", 404);
      const allowed: Record<string, readonly string[]> = { ROLLED: ["ACCEPTED", "DECLINED", "REVOKED"], ACCEPTED: ["JOINED", "DEFERRED", "RENEGED"], DEFERRED: ["ACCEPTED", "DECLINED", "RENEGED"] };
      if (!allowed[offer.status]?.includes(input.data.status)) throw forbidden("invalid_offer_transition", `Offer cannot move from ${offer.status} to ${input.data.status}.`, 409);
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.offer.update({ where: { id: offer.id }, data: { status: input.data.status } });
        if (["ACCEPTED", "JOINED"].includes(input.data.status)) await tx.application.update({ where: { id: offer.application.id }, data: { status: "ACCEPTED" } });
        else if (["DECLINED", "REVOKED", "RENEGED"].includes(input.data.status)) await tx.application.update({ where: { id: offer.application.id }, data: { status: "REJECTED" } });
        if (input.data.status === "JOINED") await tx.studentProfile.update({ where: { id: offer.application.studentId }, data: { placed: true } });
        if (input.data.status === "RENEGED") {
          const otherJoined = await tx.offer.count({ where: { id: { not: offer.id }, status: "JOINED", application: { studentId: offer.application.studentId } } });
          if (otherJoined === 0) await tx.studentProfile.update({ where: { id: offer.application.studentId }, data: { placed: false } });
        }
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "placement.offer.status.changed", entityType: "offer", entityId: offer.id, metadata: { from: offer.status, to: changed.status, applicationId: offer.application.id } } });
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
      const meeting = await prisma.$transaction(async (tx) => {
        const created = await tx.meeting.create({ data: { organizationId: request.organizationId, organizerId: request.currentUserId, title: input.data.title, startsAt: new Date(input.data.startsAt), durationMinutes: input.data.durationMinutes, ...(candidate ? { candidateId: candidate.id } : {}), ...(job ? { jobId: job.id } : {}), ...(input.data.location ? { location: input.data.location } : {}), attendees: input.data.attendees, ...(input.data.notes ? { notes: input.data.notes } : {}) }, include: { candidate: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, organizer: { select: { id: true, name: true } } } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "meeting.created", entityType: "meeting", entityId: created.id, metadata: { candidateId: created.candidateId, jobId: created.jobId, startsAt: created.startsAt.toISOString() } } });
        return created;
      });
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
        const last = await tx.pipelineStage.findFirst({ where: { organizationId: request.organizationId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
        const created = await tx.pipelineStage.create({ data: { organizationId: request.organizationId, name: input.data.name, color: input.data.color, terminal: input.data.terminal, sortOrder: (last?.sortOrder ?? -1) + 1 } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "pipeline.stage.created", entityType: "pipeline_stage", entityId: created.id } });
        return created;
      });
      return reply.status(201).send(stage);
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
      const existing = await prisma.pipelineStage.findFirst({ where: { id: request.params.stageId, organizationId: request.organizationId }, include: { _count: { select: { candidateJobs: true } } } });
      if (!existing) throw forbidden("pipeline_stage_not_found", "Pipeline stage was not found in this organization.", 404);
      if (existing._count.candidateJobs > 0) throw forbidden("pipeline_stage_in_use", "Move candidates to another stage before deleting this one.", 409);
      const stageCount = await prisma.pipelineStage.count({ where: { organizationId: request.organizationId } });
      if (stageCount <= 1) throw forbidden("last_pipeline_stage", "A workspace must keep at least one pipeline stage.", 409);
      await prisma.$transaction(async (tx) => {
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
      const updated = await prisma.candidateJob.update({
        where: { id: candidateJob.id },
        data: { stageId: stage.id },
        include: { candidate: { select: { name: true } }, job: { select: { title: true } }, stage: { select: { id: true, name: true } } }
      });
      await prisma.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "pipeline.stage.changed",
          entityType: "candidate_job",
          entityId: updated.id,
          metadata: { fromStageId: candidateJob.stageId, toStageId: stage.id, jobId: candidateJob.jobId }
        }
      });
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
      const assignment = await prisma.candidateJob.create({
        data: { candidateId: candidate.id, jobId: job.id, stageId: firstStage.id },
        include: { candidate: { select: { name: true } }, job: { select: { title: true } }, stage: { select: { id: true, name: true } } }
      });
      await prisma.auditEvent.create({
        data: {
          organizationId: request.organizationId,
          actorId: request.currentUserId,
          action: "pipeline.candidate.added",
          entityType: "candidate_job",
          entityId: assignment.id,
          metadata: { candidateId: candidate.id, jobId: job.id, stageId: firstStage.id }
        }
      });
      return reply.status(201).send(assignment);
    });

    v1.post("/candidates", {
      schema: { tags: ["Candidates"], summary: "Add a candidate to the talent pool" }
    }, async (request, reply) => {
      requirePermission(request, "candidate.manage");
      const input = z.object({ name: z.string().trim().min(2).max(120), email: z.email(), phone: z.string().trim().max(40).optional(), headline: z.string().trim().max(180).optional(), source: z.string().trim().max(40).default("MANUAL") }).safeParse(request.body);
      if (!input.success) throw forbidden("invalid_candidate", "Candidate details are invalid.", 422);
      const created = await prisma.candidate.create({ data: { organizationId: request.organizationId, name: input.data.name, email: input.data.email.toLowerCase(), phone: input.data.phone ?? null, headline: input.data.headline ?? null, source: input.data.source } });
      await prisma.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "candidate.created", entityType: "candidate", entityId: created.id } });
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

      const existingLedger = await prisma.creditLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: request.organizationId, idempotencyKey: idempotencyKey.data } } });
      if (existingLedger?.referenceId) {
        const existing = await prisma.assessment.findUnique({ where: { id: existingLedger.referenceId } });
        if (existing) return reply.header("Idempotent-Replay", "true").send({ assessment: existing, launchUrl: null, replayed: true });
      }

      const [candidateRecord, round] = await Promise.all([
        prisma.candidate.findFirst({ where: { id: input.data.candidateId, organizationId: request.organizationId }, select: { id: true } }),
        prisma.round.findFirst({ where: { id: input.data.roundId, job: { organizationId: request.organizationId } }, select: { id: true, type: true } })
      ]);
      if (!candidateRecord || !round) throw forbidden("assessment_target_not_found", "Candidate or round was not found in this organization.", 404);

      const cost = creditCosts[round.type as AssessmentType];
      const rawToken = randomBytes(32).toString("base64url");
      const assessment = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.findUniqueOrThrow({ where: { id: request.organizationId }, select: { creditBalance: true } });
        const balanceAfter = applyCreditMovement(organization.creditBalance, -cost);
        const created = await tx.assessment.create({ data: { candidateId: candidateRecord.id, roundId: round.id, status: "PENDING", launchTokenHash: tokenHash(rawToken), launchExpiresAt: new Date(Date.now() + input.data.expiresInHours * 60 * 60 * 1000) } });
        await tx.organization.update({ where: { id: request.organizationId }, data: { creditBalance: balanceAfter } });
        await tx.creditLedger.create({ data: { organizationId: request.organizationId, amount: -cost, balanceAfter, reason: `Assessment created: ${round.type}`, idempotencyKey: idempotencyKey.data, referenceType: "assessment", referenceId: created.id } });
        await tx.auditEvent.create({ data: { organizationId: request.organizationId, actorId: request.currentUserId, action: "assessment.created", entityType: "assessment", entityId: created.id, metadata: { type: round.type, creditCost: cost } } });
        return created;
      });
      return reply.status(201).send({ assessment, launchUrl: `${process.env.WEB_URL ?? "http://localhost:3000"}/assess/${rawToken}`, replayed: false });
    });

    v1.get("/assessments", {
      schema: { tags: ["Assessments"], summary: "List assessment outcomes in the active organization" }
    }, async (request) => {
      requirePermission(request, "report.read");
      const data = await prisma.assessment.findMany({
        where: { candidate: { organizationId: request.organizationId } },
        select: {
          id: true,
          status: true,
          score: true,
          summary: true,
          createdAt: true,
          completedAt: true,
          candidate: { select: { id: true, name: true, email: true } },
          round: { select: { id: true, title: true, type: true, job: { select: { id: true, title: true } } } }
        },
        orderBy: { createdAt: "desc" },
        take: 100
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
          candidate: { select: { id: true, name: true, email: true, headline: true } },
          round: {
            select: {
              id: true,
              title: true,
              type: true,
              durationMinutes: true,
              job: { select: { id: true, title: true, requirements: { orderBy: { sortOrder: "asc" } } } }
            }
          },
          evidence: { orderBy: { weight: "desc" } },
          integrityEvents: { orderBy: { occurredAt: "asc" } }
        }
      });
      if (!assessment) throw forbidden("assessment_not_found", "Assessment report was not found in this organization.", 404);
      return { assessment, advisoryOnly: true };
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

  app.addHook("onClose", async () => {
    if (assessmentQueue) await assessmentQueue.close();
    assessmentQueue = null;
  });

  return app;
}
