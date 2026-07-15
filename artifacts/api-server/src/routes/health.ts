import { Router, type IRouter } from "express";
import { HealthCheckResponse, API_CONTRACT_VERSION } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { registry } from "../lib/metrics";
import { requireOpToken } from "../lib/op-token";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// contractVersion is baked in at build time from openapi.yaml info.version.
// The web apps compare it with their own baked-in copy and show a "stale
// server build" banner on mismatch — turning the recurring
// merged-but-not-restarted deployment state into a self-diagnosing one.
//
// This is the LIVENESS probe: it deliberately does NOT touch the database, so
// the process reports alive even during a transient DB outage (a liveness
// failure would make the orchestrator kill an otherwise-healthy instance).
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    contractVersion: API_CONTRACT_VERSION,
  });
  res.json(data);
});

// READINESS probe (OBS-01): reports whether the instance can actually serve
// traffic, which for this app means the database is reachable. A load balancer
// or orchestrator routes to instances returning 200 and drains those returning
// 503 — distinguishing "process up but DB unreachable" from healthy, which
// /healthz cannot. Uses the raw pool (no tenant context needed).
router.get("/readyz", async (_req, res): Promise<void> => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch (err) {
    logger.error({ err }, "readiness probe: database unreachable");
    res.status(503).json({ status: "unavailable", reason: "database" });
  }
});

// Prometheus scrape endpoint (OBS-01). Aggregate process + request + sweep
// metrics only — no per-tenant labels or PII — so it is safe to serve on the
// public path like /healthz. Deployments that want scrape access closed set
// METRICS_TOKEN (opt-in; unset keeps it open) — see lib/op-token.ts.
router.get("/metrics", requireOpToken("METRICS_TOKEN"), async (_req, res): Promise<void> => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});

export default router;
