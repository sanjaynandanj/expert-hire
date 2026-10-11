import { describe, expect, it } from "vitest";
import { decryptWebhookSecret, encryptWebhookSecret, validateWebhookDestination, verifyWebhookSignature, webhookSignature } from "./webhooks";

describe("webhook security helpers", () => {
  it("encrypts the signing secret for database storage", () => {
    const secret = "whsec_test-secret-value";
    expect(decryptWebhookSecret(encryptWebhookSecret(secret))).toBe(secret);
  });

  it("authenticates signatures and rejects stale timestamps", () => {
    const secret = "whsec_test-secret-value";
    const body = JSON.stringify({ id: "evt_1", type: "candidate.created" });
    const timestamp = 1_800_000_000;
    const signature = webhookSignature(secret, timestamp, body);
    expect(verifyWebhookSignature({ secret, timestamp, body, signature, now: timestamp * 1_000 })).toBe(true);
    expect(verifyWebhookSignature({ secret, timestamp, body: `${body} `, signature, now: timestamp * 1_000 })).toBe(false);
    expect(verifyWebhookSignature({ secret, timestamp, body, signature, now: (timestamp + 301) * 1_000 })).toBe(false);
  });

  it("rejects non-HTTPS, local, and private destinations", async () => {
    await expect(validateWebhookDestination("http://example.com/hook")).rejects.toThrow(/HTTPS/);
    await expect(validateWebhookDestination("https://localhost/hook")).rejects.toThrow(/public internet/);
    await expect(validateWebhookDestination("https://127.0.0.1/hook")).rejects.toThrow(/public internet/);
  });
});
