import { Router, type IRouter } from "express";
import { HealthCheckResponse, API_CONTRACT_VERSION } from "@workspace/api-zod";

const router: IRouter = Router();

// contractVersion is baked in at build time from openapi.yaml info.version.
// The web apps compare it with their own baked-in copy and show a "stale
// server build" banner on mismatch — turning the recurring
// merged-but-not-restarted deployment state into a self-diagnosing one.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    contractVersion: API_CONTRACT_VERSION,
  });
  res.json(data);
});

export default router;
