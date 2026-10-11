import { claimWebhookDelivery, finishWebhookDelivery, prisma, recoverWebhookDeliveries, webhookAttemptLimit, webhookLeaseMs } from "@northstar/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.ACCOUNT_FLOW_INTEGRATION === "1";
let organizationId: string;
let endpointId: string;
const now = new Date("2099-01-01T00:00:00.000Z");

describe.skipIf(!enabled)("webhook delivery ownership and recovery", () => {
  beforeAll(async () => {
    const organization = await prisma.organization.create({ data: { slug: `codex-webhook-lease-${randomUUID()}`, name: "Fictional webhook lease verification", type: "EMPLOYER" } });
    organizationId = organization.id;
    const endpoint = await prisma.webhookEndpoint.create({ data: { organizationId, url: "https://lease-fixture.example.test", events: ["candidate.created"], secretHash: "fictional-lease-secret", active: false } });
    endpointId = endpoint.id;
  });
  afterAll(async () => {
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
  });

  async function delivery() {
    return prisma.webhookDelivery.create({ data: { endpointId, eventId: randomUUID(), eventType: "candidate.created", payload: { fictional: true }, nextAttemptAt: now } });
  }

  it("gives one competing worker ownership and accepts only its result", async () => {
    const row = await delivery();
    const claims = await Promise.all([0, 1].map(() => prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, now))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims.find((claim) => claim !== null)!;
    expect(owner.delivery.attemptCount).toBe(1);
    expect(owner.delivery.processingExpiresAt?.getTime()).toBe(now.getTime() + webhookLeaseMs);
    expect(await finishWebhookDelivery(prisma, row.id, "wrong-token", { status: "DELIVERED", statusCode: 200, error: null }, now)).toBe(false);
    expect(await finishWebhookDelivery(prisma, row.id, owner.token, { status: "DELIVERED", statusCode: 200, error: null }, now)).toBe(true);
    expect(await prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, now))).toBeNull();
    expect(await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).toMatchObject({ status: "DELIVERED", attemptCount: 1, processingToken: null, processingExpiresAt: null });
  });

  it("recovers an expired worker without permitting its late result to overwrite the new owner", async () => {
    const row = await delivery();
    const old = await prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, now));
    expect(old).not.toBeNull();
    const expired = new Date(now.getTime() + webhookLeaseMs + 1);
    expect(await finishWebhookDelivery(prisma, row.id, old!.token, { status: "DELIVERED", statusCode: 200, error: null }, expired)).toBe(false);
    expect(await prisma.$transaction((tx) => recoverWebhookDeliveries(tx, expired, endpointId))).toMatchObject({ recovered: 1, exhausted: 0 });
    const current = await prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, expired));
    expect(current).not.toBeNull();
    expect(current!.delivery.attemptCount).toBe(2);
    expect(current!.token).not.toBe(old!.token);
    expect(await finishWebhookDelivery(prisma, row.id, old!.token, { status: "FAILED", statusCode: 500, error: "late failure" }, expired)).toBe(false);
    expect(await finishWebhookDelivery(prisma, row.id, current!.token, { status: "DELIVERED", statusCode: 204, error: null }, expired)).toBe(true);
    expect(await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).toMatchObject({ status: "DELIVERED", attemptCount: 2, lastStatusCode: 204, lastError: null });
  });

  it("preserves the retry budget across repeated worker exits", async () => {
    const row = await delivery();
    let clock = now;
    for (let attempt = 1; attempt <= webhookAttemptLimit; attempt++) {
      const claimed = await prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, clock));
      expect(claimed!.delivery.attemptCount).toBe(attempt);
      clock = new Date(clock.getTime() + webhookLeaseMs + 1);
      const recovery = await prisma.$transaction((tx) => recoverWebhookDeliveries(tx, clock, endpointId));
      expect(recovery).toEqual(attempt < webhookAttemptLimit ? { recovered: 1, exhausted: 0 } : { recovered: 0, exhausted: 1 });
    }
    expect(await prisma.$transaction((tx) => claimWebhookDelivery(tx, row.id, clock))).toBeNull();
    expect(await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).toMatchObject({ status: "FAILED", attemptCount: webhookAttemptLimit, processingToken: null });
  });

  it("leaves active leases and future retries alone while recovering legacy rows", async () => {
    const active = await delivery();
    const claim = await prisma.$transaction((tx) => claimWebhookDelivery(tx, active.id, now));
    const delayed = await delivery();
    await prisma.webhookDelivery.update({ where: { id: delayed.id }, data: { nextAttemptAt: new Date(now.getTime() + 10000) } });
    expect(await prisma.$transaction((tx) => claimWebhookDelivery(tx, delayed.id, now))).toBeNull();
    const legacy = await delivery();
    await prisma.webhookDelivery.update({ where: { id: legacy.id }, data: { status: "PROCESSING", attemptCount: 2 } });
    expect(await prisma.$transaction((tx) => recoverWebhookDeliveries(tx, now, endpointId))).toEqual({ recovered: 1, exhausted: 0 });
    expect(await prisma.webhookDelivery.findUnique({ where: { id: active.id } })).toMatchObject({ status: "PROCESSING", processingToken: claim!.token });
    expect(await prisma.webhookDelivery.findUnique({ where: { id: legacy.id } })).toMatchObject({ status: "PENDING", attemptCount: 2, processingToken: null });
  });
});
