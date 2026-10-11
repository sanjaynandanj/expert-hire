import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadinessProbe } from "./readiness";

describe("bounded single-flight readiness probes", () => {
  afterEach(() => vi.useRealTimers());
  it("shares an unresolved operation even after caller timeouts, then recovers", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const probe = createReadinessProbe(check, 100);
    const callers = [probe(), probe(), probe()];
    const results = Promise.allSettled(callers);
    await vi.advanceTimersByTimeAsync(100);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    const next = expect(probe()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(check).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    check.mockResolvedValue(undefined);
    await expect(probe()).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears settled failures and timers so a later healthy probe can recover", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValueOnce(new Error("Fictional dependency outage")).mockResolvedValue(undefined);
    const probe = createReadinessProbe(check);
    await expect(probe()).rejects.toThrow(/outage/);
    await expect(probe()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles synchronous failures without leaving a stuck operation", async () => {
    const check = vi.fn((): Promise<void> => { throw new Error("Fictional synchronous failure"); });
    const probe = createReadinessProbe(check);
    await expect(probe()).rejects.toThrow(/synchronous/);
    check.mockResolvedValue(undefined);
    await expect(probe()).resolves.toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 30_001, 1.5])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => createReadinessProbe(async () => undefined, timeoutMs)).toThrow(/timeout/);
  });
});
