import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Request, Response, NextFunction } from "express";

// Prometheus metrics (OBS-01), hand-rolled and dependency-free. A metrics
// library (prom-client) would pull in @opentelemetry/api, which forks
// drizzle-orm into a second peer variant and breaks the whole api-server
// type-check (a real dual-package hazard, not just a type nit). The exposition
// format is small and stable, so this exposes exactly the series we need —
// request latency, process health, and sweep liveness — with zero new deps.
//
// Aggregate counters only (no per-tenant labels, no PII), so GET /api/metrics
// is safe to serve on the public path like /healthz; restrict at the ingress
// if scrape access must be limited.

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type Labels = Record<string, string>;

function fmtLabels(labels: Labels): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  const inner = keys
    .map(
      (k) =>
        `${k}="${String(labels[k])
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")}"`,
    )
    .join(",");
  return `{${inner}}`;
}

interface Metric {
  expose(): string;
}

export class Counter implements Metric {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, amount = 1): void {
    const key = fmtLabels(labels);
    const entry = this.series.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.series.set(key, entry);
  }
  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${fmtLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge implements Metric {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(value: number): void {
    this.value = value;
  }
  setToCurrentTime(): void {
    this.value = Date.now() / 1000;
  }
  expose(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }
}

export class Histogram implements Metric {
  private readonly buckets: number[];
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(labels: Labels, value: number): void {
    const key = fmtLabels(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    // counts[i] is the cumulative "<= bucket[i]" tally Prometheus expects.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  // Returns a function that records the elapsed seconds when called; extra
  // labels supplied at stop time (e.g. the response status) are merged in.
  startTimer(base: Labels = {}): (extra?: Labels) => void {
    const start = process.hrtime.bigint();
    return (extra: Labels = {}) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe({ ...base, ...extra }, seconds);
    };
  }
  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${fmtLabels({ ...s.labels, le: String(this.buckets[i]) })} ${s.counts[i]}`,
        );
      }
      lines.push(
        `${this.name}_bucket${fmtLabels({ ...s.labels, le: "+Inf" })} ${s.count}`,
      );
      lines.push(`${this.name}_sum${fmtLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

const httpDuration = new Histogram(
  "http_request_duration_seconds",
  "HTTP request duration in seconds, by method/route/status.",
  // Sub-100ms is the happy path; 5s is the slow tail.
  [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
);

// Compliance-sweep health: is the minute loop running and succeeding? A
// last-success timestamp far in the past is the alert condition (the overnight
// Autoscale-freeze failure the external /internal/sweep trigger guards against).
export const sweepRunsTotal = new Counter(
  "meridian_sweep_runs_total",
  "Compliance sweep passes completed.",
);
export const sweepErrorsTotal = new Counter(
  "meridian_sweep_errors_total",
  "Errors thrown by individual compliance sweeps within a pass.",
);
export const sweepLastSuccess = new Gauge(
  "meridian_sweep_last_success_timestamp_seconds",
  "Unix time of the last completed compliance sweep pass.",
);

const METRICS: Metric[] = [
  httpDuration,
  sweepRunsTotal,
  sweepErrorsTotal,
  sweepLastSuccess,
];

// Event-loop lag: the single most useful process-health signal for a Node
// service. Started once at module load; read at scrape time.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

function processMetrics(): string {
  const mem = process.memoryUsage();
  const rows = [
    ["nodejs_eventloop_lag_seconds", "gauge", "Mean event-loop delay.", loopDelay.mean / 1e9],
    ["process_resident_memory_bytes", "gauge", "Resident set size.", mem.rss],
    ["nodejs_heap_used_bytes", "gauge", "V8 heap used.", mem.heapUsed],
    ["nodejs_heap_total_bytes", "gauge", "V8 heap total.", mem.heapTotal],
    ["process_uptime_seconds", "gauge", "Process uptime.", process.uptime()],
  ] as const;
  return rows
    .map(
      ([name, type, help, value]) =>
        `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`,
    )
    .join("\n");
}

export const registry = {
  contentType: CONTENT_TYPE,
  async metrics(): Promise<string> {
    return (
      [processMetrics(), ...METRICS.map((m) => m.expose())].join("\n") + "\n"
    );
  },
};

// Collapse id-like path segments so a route label cannot explode cardinality
// (one series per invoice/party uuid would be unbounded).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeRoute(path: string): string {
  const norm = path
    .split("/")
    .map((seg) => (UUID_RE.test(seg) ? ":id" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/");
  return norm || "/";
}

// Times every request and records it once the response finishes. Runs early in
// the chain so it captures total in-server time including auth and RLS setup.
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // The scrape endpoint itself is not worth timing (self-referential noise).
  if (req.path === "/api/metrics") {
    next();
    return;
  }
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const path = req.originalUrl.split("?")[0];
    end({
      method: req.method,
      route: normalizeRoute(path),
      status: String(res.statusCode),
    });
  });
  next();
}
