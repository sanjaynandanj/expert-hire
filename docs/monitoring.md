# Operations monitoring

API and worker expose authenticated `GET /metrics` endpoints in the [Prometheus text format](https://prometheus.io/docs/instrumenting/exposition_formats/). Set `METRICS_TOKEN` to a dedicated random secret of at least 32 characters in each service. Without it the endpoint returns 404; a missing or incorrect bearer token returns 401. Keep scrapes on a private network, use TLS when crossing hosts, and never reuse session or encryption secrets. Worker metrics use its private health listener (port 4001 by default).

Use [the example scrape configuration](../ops/prometheus.yml.example), adjusting service names and mounting bearer-token files outside the repository. Different service tokens are supported. The example assumes a trusted private container network; configure HTTPS and CA verification for production transport. Prometheus [authorization configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) supports credentials files. Do not commit tokens or expose this endpoint through the public web proxy.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `northstar_http_requests_total` | method, route, status | Completed API requests by route template and HTTP status class |
| `northstar_http_request_duration_seconds` | method, route, status | API response-duration histogram |
| `northstar_worker_jobs_total` | task, outcome | Observed worker attempt outcomes |
| `northstar_worker_job_duration_seconds` | task, outcome | Worker attempt-duration histogram |
| `northstar_process_uptime_seconds` | none | Process uptime |
| `northstar_process_resident_memory_bytes` | none | Resident memory |
| `northstar_process_heap_used_bytes` | none | Used JavaScript heap |

Routes use templates, not candidate IDs or query strings; unknown routes share `unmatched`, and distinct route labels are bounded. Metrics requests do not count themselves. Worker tasks are assessment, webhook delivery, webhook sweep, and retention. Outcomes distinguish completed, retry, failed, blocked, and skipped. A retry is an attempt failure with attempts remaining, not a completed job. Intentionally blocked coding execution is not successful assessment evaluation.

Counters are process-local and reset on restart; use `rate` or `increase`, not raw counts, for alerts. Scrape each replica separately. Histogram buckets are cumulative and durations are in seconds. Worker health requests are not included in HTTP metrics. Queue backlog, pending-delivery age, dependency latency, and business/audit data are not exported.

[Initial alert rules](../ops/alerts.yml) cover scrape failures, API server-error rate, API latency, and terminal worker failures. Tune thresholds with measured traffic, route alerts to an on-call destination, and test a deliberate failure before treating monitoring as operational. A successful scrape does not prove dependency readiness: separately probe `/ready` for each service. The examples do not deploy Prometheus, configure alert routing, or provide a production availability guarantee.

API and worker readiness probes check PostgreSQL and issue an actual Redis `PING` (the API uses its queue's Redis connection). Each dependency has a three-second caller deadline and at most one outstanding operation per service instance; simultaneous requests share that operation. Timed-out driver operations are not cancelled, and remain shared until they settle so later probes cannot accumulate more dependency calls. A permanently stuck driver operation requires driver reconnection or a service restart; a timeout alone is not evidence that the underlying operation ended. Readiness returns an uncached 503 with no dependency error details, while liveness stays independent of these checks. Successful probes are not cached, so subsequent dependency failures are checked again.
