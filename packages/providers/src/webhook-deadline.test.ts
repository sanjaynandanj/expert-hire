import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { sendSignedWebhook, validateWebhookDestination } from "./webhooks";

const input = { url: "https://hooks.example.test/event", secret: "fixture-secret", eventId: "evt_fixture", eventType: "candidate.created", payload: { id: "evt_fixture" }, timeoutMs: 100 };

describe("webhook wall-clock deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.lookup.mockReset();
    mocks.request.mockReset();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  });
  afterEach(() => vi.useRealTimers());

  it("times out stalled DNS and never sends after a late lookup", async () => {
    let resolveDns!: (addresses: { address: string; family: number }[]) => void;
    mocks.lookup.mockImplementation(() => new Promise((resolve) => { resolveDns = resolve; }));
    const result = expect(sendSignedWebhook(input)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await result;
    resolveDns([{ address: "8.8.8.8", family: 4 }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds destination validation during endpoint registration", async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const result = expect(validateWebhookDestination(input.url)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    expect(mocks.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a connected request using the budget remaining after DNS", async () => {
    mocks.lookup.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 60)));
    let signal!: AbortSignal;
    mocks.request.mockImplementation((_url: URL, options: RequestOptions) => {
      signal = options.signal!;
      return Object.assign(new EventEmitter(), { end: vi.fn() });
    });
    const result = expect(sendSignedWebhook(input)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([204, 429, 302])("discards HTTP %s bodies and clears the deadline", async (statusCode) => {
    const destroy = vi.fn();
    mocks.request.mockImplementation((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      return Object.assign(new EventEmitter(), { end: () => callback({ statusCode, destroy } as unknown as IncomingMessage) });
    });
    if (statusCode === 204) await expect(sendSignedWebhook(input)).resolves.toEqual({ statusCode });
    else await expect(sendSignedWebhook(input)).rejects.toMatchObject({ statusCode });
    expect(destroy).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 30_001, Infinity, NaN, 1.5])("rejects invalid timeout %s before lookup", async (timeoutMs) => {
    await expect(sendSignedWebhook({ ...input, timeoutMs })).rejects.toThrow(/timeout must/);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
