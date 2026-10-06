import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const app = await buildApp();

afterAll(async () => app.close());

describe("system routes", () => {
  it("reports liveness without tenant context", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("requires an authenticated session for workspace data", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/jobs" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_required");
  });

  it("allows browser preflight for pipeline stage changes", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/candidate-jobs/example/stage",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,x-organization-id"
      }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
  });

  it("rejects cross-origin state-changing requests before authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: {}
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("cross_origin_request");
  });
});
