import { test } from "node:test";
import assert from "node:assert/strict";
import { Counter, Gauge, Histogram, registry, routeLabel } from "./metrics.ts";
import type { Request, Response } from "express";

// The hand-rolled Prometheus exposition primitives: cumulative histogram
// buckets, labeled counters, and gauges must serialize to valid text.

test("counter sums per label set and defaults to zero", () => {
  const c = new Counter("test_total", "help");
  assert.match(c.expose(), /test_total 0/);
  c.inc({ kind: "a" });
  c.inc({ kind: "a" });
  c.inc({ kind: "b" }, 5);
  const out = c.expose();
  assert.match(out, /test_total\{kind="a"\} 2/);
  assert.match(out, /test_total\{kind="b"\} 5/);
  assert.match(out, /# TYPE test_total counter/);
});

test("gauge holds the last value and can stamp the current time", () => {
  const g = new Gauge("test_gauge", "help");
  g.set(42);
  assert.match(g.expose(), /test_gauge 42/);
  g.setToCurrentTime();
  const value = Number(g.expose().trim().split("\n").pop()!.split(" ")[1]);
  assert.ok(value > 1_700_000_000, "should be a recent unix timestamp in seconds");
});

test("histogram buckets are cumulative and +Inf equals the count", () => {
  const h = new Histogram("test_seconds", "help", [0.1, 0.5, 1]);
  h.observe({ route: "/x" }, 0.05); // <= all three buckets
  h.observe({ route: "/x" }, 0.4); // <= 0.5 and 1
  h.observe({ route: "/x" }, 2); // <= none (only +Inf)
  const out = h.expose();
  assert.match(out, /test_seconds_bucket\{route="\/x",le="0\.1"\} 1/);
  assert.match(out, /test_seconds_bucket\{route="\/x",le="0\.5"\} 2/);
  assert.match(out, /test_seconds_bucket\{route="\/x",le="1"\} 2/);
  assert.match(out, /test_seconds_bucket\{route="\/x",le="\+Inf"\} 3/);
  assert.match(out, /test_seconds_count\{route="\/x"\} 3/);
  assert.match(out, /test_seconds_sum\{route="\/x"\} 2\.45/);
});

test("startTimer observes an elapsed duration and merges stop-time labels", () => {
  const h = new Histogram("timed_seconds", "help", [0.001, 1]);
  const end = h.startTimer({ method: "GET" });
  end({ status: "200" });
  const out = h.expose();
  assert.match(out, /timed_seconds_count\{method="GET",status="200"\} 1/);
});

test("label values with quotes/backslashes are escaped", () => {
  const c = new Counter("esc_total", "help");
  c.inc({ route: 'a"b\\c' });
  assert.match(c.expose(), /route="a\\"b\\\\c"/);
});

test("registry exposition includes process and app series", async () => {
  const text = await registry.metrics();
  assert.match(text, /process_resident_memory_bytes/);
  assert.match(text, /nodejs_eventloop_lag_seconds/);
  assert.match(text, /http_request_duration_seconds/);
  assert.match(text, /meridian_sweep_last_success_timestamp_seconds/);
  assert.equal(registry.contentType.includes("text/plain"), true);
});

// The route label must stay bounded under hostile traffic: matched routes
// report their pattern, unmatched errors collapse into one series, and only
// successful static paths keep the (id-collapsed) literal path.
test("routeLabel is bounded: pattern for matched, 'unmatched' for erroring paths", () => {
  const fake = (over: {
    route?: { path: string };
    baseUrl?: string;
    originalUrl: string;
    status: number;
  }) =>
    [
      {
        route: over.route,
        baseUrl: over.baseUrl ?? "",
        originalUrl: over.originalUrl,
        method: "GET",
      } as unknown as Request,
      { statusCode: over.status } as unknown as Response,
    ] as const;

  const [matchedReq, matchedRes] = fake({
    route: { path: "/invoices/:id" },
    baseUrl: "/api",
    originalUrl: "/api/invoices/9be0a0f0-0000-4000-8000-000000000000",
    status: 200,
  });
  assert.equal(routeLabel(matchedReq, matchedRes), "/api/invoices/:id");

  // A bot scan 404s with no matched route: one shared series, not one per path.
  const [scanReq, scanRes] = fake({ originalUrl: "/wp-admin/setup.php", status: 404 });
  assert.equal(routeLabel(scanReq, scanRes), "unmatched");

  // A 401 thrown before routing (principal middleware) likewise collapses.
  const [authReq, authRes] = fake({ originalUrl: "/api/anything-goes-here", status: 401 });
  assert.equal(routeLabel(authReq, authRes), "unmatched");

  // A successful non-route response (static asset) keeps its bounded path,
  // with uuid segments still collapsed.
  const [staticReq, staticRes] = fake({
    originalUrl: "/assets/app.js?v=1",
    status: 200,
  });
  assert.equal(routeLabel(staticReq, staticRes), "/assets/app.js");
});
