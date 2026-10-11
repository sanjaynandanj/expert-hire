import { describe, expect, it } from "vitest";
import { authorizeMetrics, OperationsMetrics } from "./operations-metrics";

describe("operations metrics", () => {
  it("exports cumulative latency buckets and request outcomes", () => {
    const metrics = new OperationsMetrics();
    metrics.recordHttp("GET", "/v1/jobs/:jobId", 200, 0.03);
    metrics.recordHttp("GET", "/v1/jobs/:jobId", 201, 0.1);
    const text = metrics.render();
    const labels = 'method="GET",route="/v1/jobs/:jobId",status="2xx"';
    expect(text).toContain(`northstar_http_requests_total{${labels}} 2\n`);
    expect(text).toContain(`northstar_http_request_duration_seconds_bucket{${labels},le="0.025"} 0\n`);
    expect(text).toContain(`northstar_http_request_duration_seconds_bucket{${labels},le="0.05"} 1\n`);
    expect(text).toContain(`northstar_http_request_duration_seconds_bucket{${labels},le="+Inf"} 2\n`);
    expect(text).toContain(`northstar_http_request_duration_seconds_count{${labels}} 2\n`);
    expect(text).toContain(`northstar_http_request_duration_seconds_sum{${labels}} 0.13\n`);
  });

  it("bounds route cardinality and aggregates unknown routes", () => {
    const metrics = new OperationsMetrics();
    for (let index = 0; index < 200; index++) metrics.recordHttp("CUSTOM", `/route/${index}`, 404, 0.01);
    metrics.recordHttp("GET", undefined, 404, 0.01);
    const text = metrics.render();
    expect(text).not.toContain('/route/199');
    expect(text).toContain('northstar_http_requests_total{method="OTHER",route="other",status="4xx"} 72');
    expect(text).not.toContain('method="CUSTOM"');
  });

  it("records worker failure outcomes and requires an exact bearer token", () => {
    const metrics = new OperationsMetrics();
    metrics.recordJob("webhook_delivery", "failed", 2);
    expect(metrics.render()).toContain('northstar_worker_jobs_total{task="webhook_delivery",outcome="failed"} 1');
    const token = "a".repeat(32);
    expect(authorizeMetrics(`Bearer ${token}`, token)).toBe(true);
    expect(authorizeMetrics(`Bearer ${token}x`, token)).toBe(false);
    expect(authorizeMetrics(undefined, token)).toBe(false);
    expect(authorizeMetrics(`Bearer ${token}`, undefined)).toBe(false);
  });
});
