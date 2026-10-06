import { describe, expect, it } from "vitest";
import { LocalBillingProvider, LocalEvaluationProvider } from "./index";

describe("local evaluation provider", () => {
  it("returns deterministic, reviewable, advisory evidence", async () => {
    const provider = new LocalEvaluationProvider();
    const input = {
      assessmentId: "assessment_demo",
      jobDescription: "Operate distributed systems",
      response: "I improved a distributed system by changing queue durability and documenting the recovery trade-off for the team.",
      criteria: [{ name: "Distributed systems", weight: 80 }, { name: "Communication", weight: 20 }]
    };
    const first = await provider.evaluate(input);
    const second = await provider.evaluate(input);
    expect(first).toEqual(second);
    expect(first.advisoryOnly).toBe(true);
    expect(first.evidence).toHaveLength(2);
    expect(first.evidence[0]?.evidence).toContain("distributed system");
  });
});

describe("local billing provider", () => {
  it("never creates a real payment session", async () => {
    const provider = new LocalBillingProvider();
    const checkout = await provider.createCheckout({ accountId: "org_demo", productCode: "EXPLORER", successUrl: "http://localhost/success", cancelUrl: "http://localhost/cancel" });
    expect(checkout.checkoutUrl).toContain("local_checkout=");
    await expect(provider.readSubscription("org_demo")).resolves.toEqual({ status: "TRIAL", plan: "LOCAL_DEMO" });
  });
});
