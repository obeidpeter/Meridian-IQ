import { Router, type IRouter } from "express";
import { runScheduledWorkOnce } from "../modules/pipeline/pipeline";
import { requireOpToken } from "../lib/op-token";

// Public wake-up trigger for the Autoscale deployment (SME-08 reliability).
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
// Deliberately unauthenticated and safe to expose:
// - Idempotent: pre-breach alerts guard with preBreachAlertAt, breach marking
//   is a status transition, batch collection uses onConflictDoNothing, and the
//   outbox drain claims with FOR UPDATE SKIP LOCKED.
// - No auth bypass: it takes no input, acts on no caller-chosen entity, and
//   returns no tenant data — only booleans saying which passes ran. This is
//   the same work the server already runs on its own timers.
// - Hammering it is a cheap no-op: module-level guards collapse concurrent
//   triggers, and a pass with nothing due does no writes.
//
// A deployment that still wants the trigger closed sets SWEEP_TOKEN (opt-in;
// unset keeps today's open behaviour so existing schedulers are unaffected) —
// see lib/op-token.ts.
//
// GET (not POST) so any dumb pinger/cron can call it, and it stays exempt from
// the cookie-CSRF guard by construction. The path is listed in
// NO_CONTEXT_PATHS (app.ts): the pipeline work opens its own bypass
// transactions per pass, so it must not run nested inside the per-request
// tenant transaction (which would also subject the whole pass to the 30s
// request-transaction cap).
const router: IRouter = Router();

router.get("/internal/sweep", requireOpToken("SWEEP_TOKEN"), async (req, res): Promise<void> => {
  const startedAt = Date.now();
  const result = await runScheduledWorkOnce();
  req.log.info(
    { ...result, tookMs: Date.now() - startedAt },
    "external sweep trigger completed",
  );
  res.json({ status: "ok", ran: result.ran });
});

export default router;
