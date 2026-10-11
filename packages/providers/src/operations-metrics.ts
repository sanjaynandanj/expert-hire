import { createHash, timingSafeEqual } from "node:crypto";

export const metricsContentType = "text/plain; version=0.0.4; charset=utf-8";
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
type Sample = { labels: Record<string, string>; count: number; sum: number; buckets: number[] };
export type WorkerTask = "assessment" | "webhook_delivery" | "webhook_sweep" | "retention";
export type WorkerOutcome = "completed" | "retry" | "failed" | "blocked" | "skipped";

export function readMetricsToken(): string | undefined {
  const token = process.env.METRICS_TOKEN;
  if (token && token.length < 32) throw new Error("METRICS_TOKEN must contain at least 32 characters when configured.");
  return token || undefined;
}

export function authorizeMetrics(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

function labelsText(labels: Record<string, string>): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\"/g, '\\"').replace(/[\r\t]/g, " ");
  return Object.entries(labels).map(([key, value]) => `${key}="${escape(value)}"`).join(",");
}

/** Labels receive route templates and fixed task names, never URLs, IDs, or submitted data. */
export class OperationsMetrics {
  private readonly http = new Map<string, Sample>();
  private readonly jobs = new Map<string, Sample>();
  private readonly routes = new Set<string>();

  recordHttp(method: string, route: string | undefined, statusCode: number, seconds: number): void {
    let template = route ?? "unmatched";
    if (!this.routes.has(template)) {
      if (this.routes.size >= 128) template = "other";
      else this.routes.add(template);
    }
    this.observe(this.http, {
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method) ? method : "OTHER",
      route: template,
      status: statusCode >= 100 && statusCode <= 599 ? String(Math.floor(statusCode / 100)) + "xx" : "other"
    }, seconds);
  }

  recordJob(task: WorkerTask, outcome: WorkerOutcome, seconds: number): void {
    this.observe(this.jobs, { task, outcome }, seconds);
  }

  private observe(samples: Map<string, Sample>, labels: Record<string, string>, seconds: number): void {
    const key = JSON.stringify(labels);
    const sample = samples.get(key) ?? { labels, count: 0, sum: 0, buckets: buckets.map(() => 0) };
    const elapsed = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    sample.count++;
    sample.sum += elapsed;
    buckets.forEach((bound, index) => { if (elapsed <= bound) sample.buckets[index] = (sample.buckets[index] ?? 0) + 1; });
    samples.set(key, sample);
  }

  render(): string {
    const lines: string[] = [];
    const emit = (samples: Map<string, Sample>, counter: string, histogram: string) => {
      const entries = [...samples.values()].sort((a, b) => labelsText(a.labels).localeCompare(labelsText(b.labels)));
      lines.push(`# TYPE ${counter} counter`);
      for (const sample of entries) lines.push(`${counter}{${labelsText(sample.labels)}} ${sample.count}`);
      lines.push(`# TYPE ${histogram} histogram`);
      for (const sample of entries) {
        buckets.forEach((bound, index) => lines.push(`${histogram}_bucket{${labelsText({ ...sample.labels, le: String(bound) })}} ${sample.buckets[index]}`));
        lines.push(`${histogram}_bucket{${labelsText({ ...sample.labels, le: "+Inf" })}} ${sample.count}`);
        lines.push(`${histogram}_sum{${labelsText(sample.labels)}} ${sample.sum}`);
        lines.push(`${histogram}_count{${labelsText(sample.labels)}} ${sample.count}`);
      }
    };
    emit(this.http, "northstar_http_requests_total", "northstar_http_request_duration_seconds");
    emit(this.jobs, "northstar_worker_jobs_total", "northstar_worker_job_duration_seconds");
    const memory = process.memoryUsage();
    for (const [name, value] of Object.entries({ northstar_process_uptime_seconds: process.uptime(), northstar_process_resident_memory_bytes: memory.rss, northstar_process_heap_used_bytes: memory.heapUsed })) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    return lines.join("\n") + "\n";
  }
}
