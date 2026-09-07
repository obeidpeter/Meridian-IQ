import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Request, Response, NextFunction } from "express";
import { isUuid } from "./uuid";
import { databasePoolMetrics } from "@workspace/db";

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
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
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

// A gauge with labels: one series per label set (the per-sweep last-success
// timestamps). Unlike Counter it exposes nothing but HELP/TYPE until a
// series exists — an absent sweep must not read as "succeeded at epoch 0".
export class LabeledGauge implements Metric {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number): void {
    this.series.set(fmtLabels(labels), { labels, value });
  }
  setToCurrentTime(labels: Labels): void {
    this.set(labels, Date.now() / 1000);
  }
  expose(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${fmtLabels(labels)} ${value}`);
    }
    return lines.join("\n");
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
      s = {
        labels,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
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
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
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
  "valo_sweep_runs_total",
  "Compliance sweep passes completed.",
);
export const sweepErrorsTotal = new Counter(
  "valo_sweep_errors_total",
  "Failures of individual compliance sweeps within a pass, by sweep name and kind (error|timeout).",
);
export const sweepLastSuccess = new Gauge(
  "valo_sweep_last_success_timestamp_seconds",
  "Unix time of the last compliance sweep pass in which every sweep succeeded.",
);
// Per-sweep hygiene (R101): which named sweep last succeeded when, and how
// long each takes — the series an alert on "clerk.digests has not succeeded
// in a day" needs, which the pass-level gauge above cannot answer.
export const sweepLastSuccessBySweep = new LabeledGauge(
  "valo_sweep_last_success_by_sweep_timestamp_seconds",
  "Unix time each named compliance sweep last completed without error.",
);
export const sweepDurationSeconds = new Histogram(
  "valo_sweep_duration_seconds",
  "Duration of each named compliance sweep, by sweep and outcome (ok|error|timeout).",
  [0.1, 0.5, 1, 5, 15, 60, 120],
);
// The outbox drain swallows claim errors to protect the loop; this counter is
// how a persistent claim failure (permissions regression, schema drift)
// surfaces instead of the pipeline silently processing nothing.
export const outboxClaimFailuresTotal = new Counter(
  "valo_outbox_claim_failures_total",
  "Errors thrown while claiming the next outbox event.",
);
// Outbox depth and age (R96), set by the pipeline.gauges sweep: `pending` is
// ready to run, `parked` is waiting for a rail breaker, `dead` awaits an
// operator replay. A growing oldest-pending age with a flat dead count is
// the "rail outage in progress" shape; a growing dead count is the "operator
// needed" shape.
export const outboxEvents = new LabeledGauge(
  "valo_outbox_events",
  "Outbox events by state (pending, parked, processing, dead).",
);
export const outboxOldestPendingAgeSeconds = new Gauge(
  "valo_outbox_oldest_pending_age_seconds",
  "Age of the oldest pending outbox event, in seconds (0 when none).",
);
export const usabilityEventsTotal = new Counter(
  "valo_usability_events_total",
  "Privacy-safe aggregate product usability events by closed event and surface.",
);

const METRICS: Metric[] = [
  httpDuration,
  sweepRunsTotal,
  sweepErrorsTotal,
  sweepLastSuccess,
  sweepLastSuccessBySweep,
  sweepDurationSeconds,
  outboxClaimFailuresTotal,
  outboxEvents,
  outboxOldestPendingAgeSeconds,
  usabilityEventsTotal,
];

export const auditLockWaitSeconds = new Histogram(
  "valo_audit_lock_wait_seconds", "Time waiting for the global audit chain lock.",
  [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
);
export const auditLockFailures = new Counter(
  "valo_audit_lock_failures_total", "Audit lock acquisition failures; no event was appended.",
);
export const webhookFanoutOldestAge = new LabeledGauge(
  "valo_webhook_fanout_oldest_age_seconds", "Age of the oldest eligible event in the latest bounded fanout batch.",
);
export const clerkAdmissionRejected = new Counter(
  "valo_clerk_admission_rejected_total", "Clerk admissions refused before provider execution.",
);
METRICS.push(auditLockWaitSeconds, auditLockFailures, webhookFanoutOldestAge, clerkAdmissionRejected);

function poolMetrics(): string {
  const pools = databasePoolMetrics();
  const fields = [
    ["total", "connections", "gauge"], ["idle", "idle_connections", "gauge"],
    ["active", "active_connections", "gauge"], ["waiting", "waiting_requests", "gauge"],
    ["max", "max_connections", "gauge"], ["idleErrors", "idle_errors_total", "counter"],
    ["oldestAcquisitionSeconds", "oldest_acquisition_seconds", "gauge"],
    ["acquisitionCount", "acquisitions_total", "counter"],
    ["acquisitionFailures", "acquisition_failures_total", "counter"],
    ["acquisitionSeconds", "acquisition_seconds_total", "counter"],
  ] as const;
  return fields.map(([key, suffix, type]) => {
    const metric = `valo_pg_pool_${suffix}`;
    return [`# HELP ${metric} PostgreSQL pool ${suffix}.`, `# TYPE ${metric} ${type}`,
      ...pools.map((entry) => `${metric}{pool="${entry.name}"} ${entry[key]}`)].join("\n");
  }).join("\n");
}

export function recordUsabilityEvent(event: string, surface: string): void {
  usabilityEventsTotal.inc({ event, surface });
}

// Event-loop lag: the single most useful process-health signal for a Node
// service. Started once at module load; read at scrape time.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

function processMetrics(): string {
  const mem = process.memoryUsage();
  const rows = [
    [
      "nodejs_eventloop_lag_seconds",
      "gauge",
      "Mean event-loop delay.",
      loopDelay.mean / 1e9,
    ],
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
    const current = [processMetrics(), poolMetrics(), ...METRICS.map((m) => m.expose())].join("\n");
    // Preserve existing dashboards and alerts while new integrations adopt Valo.
    // Alias metric identifiers only, never labels or arbitrary help text.
    const legacy = current.split("\n")
      .filter((line) => /^(?:# (?:HELP|TYPE) )?valo_/.test(line))
      .map((line) => line.replace(/^((?:# (?:HELP|TYPE) )?)valo_/, "$1meridian_"))
      .join("\n");
    return current + "\n" + legacy + "\n";
  },
};

// Collapse id-like path segments so a route label cannot explode cardinality
// (one series per invoice/party uuid would be unbounded).
function normalizeRoute(path: string): string {
  const norm = path
    .split("/")
    .map((seg) => (isUuid(seg) ? ":id" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/");
  return norm || "/";
}

// The route label for a finished request, chosen so unauthenticated traffic
// cannot mint unbounded series (every distinct label is a permanent entry in
// the in-process registry — internet bot scans of /wp-admin, /.env etc. would
// otherwise each become a new histogram forever):
//   1. a matched Express route reports its PATTERN (bounded by the route table);
//   2. anything unmatched that errored (404s from scans, 401s thrown before
//      routing) collapses into one "unmatched" series;
//   3. successful non-route responses (static assets) keep the id-collapsed
//      path — their namespace is the deploy's file tree, which is bounded.
export function routeLabel(req: Request, res: Response): string {
  const matched = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof matched === "string") {
    return normalizeRoute(`${req.baseUrl ?? ""}${matched}`);
  }
  if (res.statusCode >= 400) return "unmatched";
  return normalizeRoute(req.originalUrl.split("?")[0]);
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
    end({
      method: req.method,
      route: routeLabel(req, res),
      status: String(res.statusCode),
    });
  });
  next();
}
