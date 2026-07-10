---
name: Deploy hang vs crash diagnostic
description: How to tell a hanging startup from a crash when a Publish fails with "port never opened"
---

# Publish fails: "required port was never opened"

When a Replit Publish promote fails with "not all artifact ports opened / required port was never opened" and the router only logs "healthcheck ... returned status 500":

**Silent for the full ~60s (no app stdout) = the process is HANGING on a blocking startup step, not crashing.** A crash/throw fails FAST and IS logged (the entrypoint's top-level catch logs and exits within ~1s). Diagnostic heuristic: a *refused* connection (ECONNREFUSED) errors fast and logs; a *dropped/unroutable* connection (SYN with no reply) hangs with zero output until the platform SIGTERMs. The app's own stdout is often NOT in the deployment log stream for a failed (non-promoted) deploy — reason from the router logs and reproduce locally with an unreachable dependency.

**How to apply:** If startup blocks on a DB/network op before `app.listen()`, the port never opens and the publish fails. Fixes: (1) open the port before any DB work so the DB-free liveness probe (`/api/healthz`) promotes the artifact; (2) give network clients a connect timeout (pg pool `connectionTimeoutMillis`) so a hang becomes a fast, logged error.

**Why:** A MeridianIQ prod Publish failed because `app.listen()` was gated behind `applyMigrations()` (first DB op) against a prod DB whose connection hung; the pool had no connect timeout, so startup blocked ~60s and the port never opened.
