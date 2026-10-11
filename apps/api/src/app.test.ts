import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

const app = await buildApp();

afterAll(async () => app.close());

describe("system routes", () => {
  it("protects metrics and records route templates without candidate identifiers", async () => {
    const token = "metrics-test-token-".repeat(3);
    vi.stubEnv("METRICS_TOKEN", token);
    const metricsApp = await buildApp();
    try {
      const unauthorized = await metricsApp.inject({ method: "GET", url: "/metrics" });
      expect(unauthorized.statusCode).toBe(401);
      await metricsApp.inject({ method: "GET", url: "/v1/candidates/private-candidate-id/notes?secret=private-query" });
      const scrape = await metricsApp.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${token}` } });
      expect(scrape.statusCode).toBe(200);
      expect(scrape.headers["content-type"]).toContain("version=0.0.4");
      expect(scrape.body).toContain('route="/v1/candidates/:candidateId/notes",status="4xx"');
      expect(scrape.body).not.toContain("private-candidate-id");
      expect(scrape.body).not.toContain("private-query");
      expect(scrape.body).not.toContain(token);
    } finally {
      await metricsApp.close();
      vi.unstubAllEnvs();
    }
  });

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

  it("accepts explicitly trusted origins even when fetch metadata says cross-site", async () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const response = await app.inject({ method: "POST", url: "/v1/jobs", headers: { origin, "sec-fetch-site": "cross-site" }, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("session_required");
    }
  });

  it("rejects untrusted origins regardless of metadata and origin-less cross-site requests", async () => {
    for (const headers of [{ origin: "https://attacker.example", "sec-fetch-site": "same-site" }, { origin: "null", "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await app.inject({ method: "POST", url: "/v1/jobs", headers, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("cross_origin_request");
    }
  });
});
