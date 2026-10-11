import { describe, expect, it, vi } from "vitest";
import { enqueuePersistedWebhooks } from "./webhook-queue";

describe("durable webhook queue submission", () => {
  it("attempts every delivery without turning a queue outage into a failed business write", async () => {
    const enqueue = vi.fn(async (id: string) => { if (id === "failed") throw new Error("Redis unavailable"); });
    const report = vi.fn();
    await enqueuePersistedWebhooks(["first", "failed", "last"], enqueue, report);
    expect(enqueue.mock.calls.map(([id]) => id)).toEqual(["first", "failed", "last"]);
    expect(report).toHaveBeenCalledExactlyOnceWith("failed", expect.any(Error));
  });

  it("bounds a hung queue call so durable acceptance can return", async () => {
    vi.useFakeTimers();
    try {
      const report = vi.fn();
      const submission = enqueuePersistedWebhooks(["hung"], async () => new Promise(() => {}), report);
      await vi.advanceTimersByTimeAsync(3_001);
      await submission;
      expect(report).toHaveBeenCalledExactlyOnceWith("hung", expect.objectContaining({ message: "Durable queue submission timed out." }));
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
