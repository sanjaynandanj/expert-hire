import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/client/client";

export const webhookAttemptLimit = 6;
export const webhookLeaseMs = 60_000;

/** Atomic compare-and-set; duplicate queue jobs cannot own the same active delivery. */
export async function claimWebhookDelivery(tx: Prisma.TransactionClient, id: string, now = new Date()) {
  const token = randomUUID();
  const claimed = await tx.webhookDelivery.updateMany({ where: { id, status: "PENDING", nextAttemptAt: { lte: now }, attemptCount: { lt: webhookAttemptLimit } }, data: { status: "PROCESSING", processingToken: token, processingExpiresAt: new Date(now.getTime() + webhookLeaseMs), attemptCount: { increment: 1 } } });
  if (!claimed.count) return null;
  const delivery = await tx.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { endpoint: true } });
  return { delivery, token };
}

export async function finishWebhookDelivery(tx: Prisma.TransactionClient, id: string, token: string, result: { status: "DELIVERED" | "PENDING" | "FAILED"; statusCode: number | null; error: string | null; nextAttemptAt?: Date }, now = new Date()) {
  const changed = await tx.webhookDelivery.updateMany({ where: { id, status: "PROCESSING", processingToken: token, processingExpiresAt: { gt: now } }, data: {
    status: result.status, lastStatusCode: result.statusCode, lastError: result.error,
    deliveredAt: result.status === "DELIVERED" ? now : null,
    nextAttemptAt: result.nextAttemptAt ?? now, processingToken: null, processingExpiresAt: null
  } });
  return changed.count === 1;
}

/** Recover expired/legacy leases, but never resurrect delivered or exhausted attempts. */
export async function recoverWebhookDeliveries(tx: Prisma.TransactionClient, now = new Date(), endpointId?: string) {
  const scope = endpointId ? { endpointId } : {};
  const expired: Prisma.WebhookDeliveryWhereInput = { status: "PROCESSING", OR: [{ processingExpiresAt: { lte: now } }, { processingExpiresAt: null }] };
  const exhausted = await tx.webhookDelivery.updateMany({ where: { ...scope, AND: [{ OR: [{ status: "PENDING" }, expired] }, { attemptCount: { gte: webhookAttemptLimit } }] }, data: { status: "FAILED", processingToken: null, processingExpiresAt: null, lastError: "Webhook retry budget exhausted; manual replay is required." } });
  const recovered = await tx.webhookDelivery.updateMany({ where: { ...scope, AND: [expired, { attemptCount: { lt: webhookAttemptLimit } }] }, data: { status: "PENDING", processingToken: null, processingExpiresAt: null, nextAttemptAt: now, lastError: "Previous worker lease expired; queued for recovery." } });
  return { exhausted: exhausted.count, recovered: recovered.count };
}
