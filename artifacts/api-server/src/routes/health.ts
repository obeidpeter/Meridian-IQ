import { Router, type IRouter } from "express";
import { HealthCheckResponse, API_CONTRACT_VERSION } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { registry } from "../lib/metrics";
import { requireOpToken } from "../lib/op-token";
import { logger } from "../lib/logger";
import { getReadiness } from "../lib/readiness";
import { deployedBuildRevision } from "../lib/build";

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
    buildRevision: deployedBuildRevision(),
  });
  res.json(data);
});

// READINESS probe (OBS-01): reports whether the instance can actually serve
// traffic, which for this app means the database is reachable. A load balancer
// or orchestrator routes to instances returning 200 and drains those returning
// 503 — distinguishing "process up but DB unreachable" from healthy, which
// /healthz cannot. Uses the raw pool (no tenant context needed).
router.get("/readyz", async (_req, res): Promise<void> => {
  const readiness = getReadiness();
  // The bootstrap gate is production-only (dev boots run migrations and seed
  // inline), but a draining instance must answer 503 everywhere so a load
  // balancer stops routing to it during a graceful shutdown (R101).
  if (
    readiness.reason === "shutting_down" ||
    (process.env.NODE_ENV === "production" && !readiness.ready)
  ) {
    res.status(503).json({
      status: "unavailable",
      reason: readiness.reason,
    });
    return;
  }
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch (err) {
    logger.error({ err }, "readiness probe: database unreachable");
    res.status(503).json({ status: "unavailable", reason: "database" });
  }
});

// Prometheus scrape endpoint (OBS-01). Aggregate process + request + sweep
// metrics only — no per-tenant labels or PII. Non-production can leave the
// endpoint open for local scraping; production fails closed when its key ring
// is missing and requires a signed request when configured.
export function metricsTokenRequired(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === "production";
}

router.get(
  "/metrics",
  requireOpToken("METRICS_TOKEN", {
    // Development keeps the frictionless local scrape. A production process
    // never exposes operational topology merely because a secret was omitted.
    required: metricsTokenRequired(),
  }),
  async (_req, res): Promise<void> => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  },
);

export default router;
