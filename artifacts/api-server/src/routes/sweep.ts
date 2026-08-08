import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { runScheduledWorkOnce } from "../modules/pipeline/pipeline";
import { requireOpToken } from "../lib/op-token";
import { bumpFixedWindow } from "../lib/fixed-window";

async function limitSweep(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const configured = Number(process.env.SWEEP_RATE_LIMIT_PER_MIN ?? 12);
  const limit =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 12;
  const row = await bumpFixedWindow(
    `rl:sweep:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
    60_000,
  );
  if (Number(row.count) > limit) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Sweep rate limit exceeded" });
    return;
  }
  next();
}

// Wake-up trigger for the Autoscale deployment (SME-08 reliability).
//
// Autoscale scales to zero when idle, which freezes the in-process worker
// timers (outbox drain, reconciliation, and the 1-minute compliance sweep that
// fires B2C pre-breach alerts). Overnight — exactly when nobody is using the
// app — those alerts would silently never fire. An external scheduler (a
// Replit Scheduled Deployment or any cron) pings this endpoint every few
// minutes; the request itself wakes an instance, and the handler runs one full
// pass of the timer work synchronously so it completes before the instance can
// be suspended again.
//
// Fail-closed behind SWEEP_TOKEN (lib/op-token.ts): unset means the trigger
// 404s, and the scheduler must present the secret as x-op-token. Even with
// the token, the handler is built to be safe against over-calling:
// - Idempotent: pre-breach alerts guard with preBreachAlertAt, breach marking
//   is a status transition, batch collection uses onConflictDoNothing, and the
//   outbox drain claims with FOR UPDATE SKIP LOCKED.
// - No auth bypass: it takes no input, acts on no caller-chosen entity, and
//   returns no tenant data — only booleans saying which passes ran. This is
//   the same work the server already runs on its own timers.
// - Hammering it is a cheap no-op: module-level guards collapse concurrent
//   triggers, a pass with nothing due does no writes, and limitSweep bounds
//   the per-IP call rate on top.
//
// GET (not POST) so any dumb pinger/cron can call it, and it stays exempt from
// the cookie-CSRF guard by construction. The path is listed in
// NO_CONTEXT_PATHS (app.ts): the pipeline work opens its own bypass
// transactions per pass, so it must not run nested inside the per-request
// tenant transaction (which would also subject the whole pass to the 30s
// request-transaction cap).
const router: IRouter = Router();

router.get(
  "/internal/sweep",
  requireOpToken("SWEEP_TOKEN", { required: true }),
  limitSweep,
  async (req, res): Promise<void> => {
    const startedAt = Date.now();
    const result = await runScheduledWorkOnce();
    req.log.info(
      { ...result, tookMs: Date.now() - startedAt },
      "external sweep trigger completed",
    );
    res.json({ status: "ok", ran: result.ran });
  },
);

export default router;
