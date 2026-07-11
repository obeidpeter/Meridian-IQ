---
name: Autoscale wake-up sweep trigger
description: Why overnight alerts need an external ping of the public sweep endpoint, and the constraints on that endpoint.
---
# Autoscale wake-up sweep trigger

- The published API runs on Autoscale, which scales to zero when idle — all in-process timers (outbox drain, reconcile, 1-minute B2C pre-breach sweep) freeze overnight. `GET /api/internal/sweep` is a public, idempotent trigger that runs one full timer pass synchronously inside the request.
  **Why:** work started after the response can be frozen mid-flight on Autoscale; awaiting the pass before responding is the only reliable way to finish it. Alerts (push + messaging) are sent inline by the sweep, not via the outbox, so one synchronous pass delivers them.
  **How to apply:** any new periodic job must be registered so this endpoint covers it (registerSweep / the shared pass), and the endpoint must stay in both PUBLIC_PATHS (principal middleware) and NO_CONTEXT_PATHS (app.ts) — pipeline passes open their own bypass transactions and must not nest inside the per-request tenant transaction or its 30s cap.

- One repl = one deployment on Replit, so the periodic ping cannot live in this repl: it needs a separate Scheduled Deployment app (or any external cron) calling the prod URL every ~5 min. `scripts/sweep-ping.sh` is the ready-made command. Until the user creates it AND republishes the API, overnight alerts do not fire.

- Concurrency safety comes from module-level guards in the pipeline worker shared between the interval loops and the external trigger — concurrent triggers skip in-flight passes (`ran.<pass>: false`), they never overlap.
