import { prisma } from "@northstar/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ready: vi.fn(), ping: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class {
  waitUntilReady = mocks.ready;
  getBackend() { return { client: Promise.resolve({ ping: mocks.ping }) }; }
  async close() {}
} }));
import { buildApp } from "./app";

let app: Awaited<ReturnType<typeof buildApp>>;
describe("API readiness during dependency outages", () => {
  beforeEach(async () => {
    mocks.ready.mockReset().mockResolvedValue(undefined);
    mocks.ping.mockReset().mockResolvedValue("PONG");
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ ready: 1 }]);
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => { await app.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("checks a real Redis command after queue initialization and never caches readiness", async () => {
    const first = await app.inject({ method: "GET", url: "/ready" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    mocks.ping.mockRejectedValueOnce(new Error("Fictional Redis outage"));
    const outage = await app.inject({ method: "GET", url: "/ready" });
    expect(outage.statusCode).toBe(503);
    expect(outage.json()).toEqual({ status: "not_ready" });
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect(mocks.ping).toHaveBeenCalledTimes(3);
  });

  it("bounds stalled queue initialization and shares it across concurrent requests", async () => {
    vi.useFakeTimers();
    mocks.ready.mockImplementation(() => new Promise(() => {}));
    const requests = Promise.all(Array.from({ length: 3 }, () => app.inject({ method: "GET", url: "/ready" }).then((response) => response)));
    await vi.advanceTimersByTimeAsync(3_001);
    for (const response of await requests) expect(response.statusCode).toBe(503);
    expect(mocks.ready).toHaveBeenCalledOnce();
    const retry = app.inject({ method: "GET", url: "/ready" }).then((response) => response);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await retry).statusCode).toBe(503);
    expect(mocks.ready).toHaveBeenCalledOnce();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("bounds stalled PostgreSQL operations without adding queries after timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.$queryRaw).mockImplementation(() => new Promise(() => {}) as ReturnType<typeof prisma.$queryRaw>);
    const response = app.inject({ method: "GET", url: "/ready" }).then((result) => result);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await response).statusCode).toBe(503);
    const retry = app.inject({ method: "GET", url: "/ready" }).then((result) => result);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await retry).statusCode).toBe(503);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("rejects unexpected Redis responses and keeps dependency details private", async () => {
    mocks.ping.mockResolvedValue("NOT_PONG");
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("Redis");
    expect(response.body).not.toContain("NOT_PONG");
  });
});
