import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/client/client";

/** Call inside the business transaction; enqueue the returned IDs only after commit. */
export async function persistWebhookEvent(tx: Prisma.TransactionClient, organizationId: string, eventType: string, data: Record<string, unknown>): Promise<string[]> {
  const endpoints = await tx.webhookEndpoint.findMany({ where: { organizationId, active: true, events: { has: eventType } }, select: { id: true } });
  if (!endpoints.length) return [];
  const eventId = randomUUID();
  const payload = { id: eventId, type: eventType, version: 1, created_at: new Date().toISOString(), data } as Prisma.InputJsonValue;
  const deliveries = endpoints.map((endpoint) => ({ id: randomUUID(), endpointId: endpoint.id, eventId, eventType, payload }));
  await tx.webhookDelivery.createMany({ data: deliveries });
  return deliveries.map((delivery) => delivery.id);
}
