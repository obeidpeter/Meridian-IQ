---
name: Request transaction boundary (tenant RLS)
description: How the api-server binds one DB transaction per request for RLS + atomicity, and why commit must precede response flush.
---
Each request runs inside one `runRequestContext` transaction that does `SET LOCAL ROLE meridian_app` + tenant GUCs (`app.bypass`, `app.firm_id`); all ambient `getDb()` calls route through this ALS-scoped tx, so RLS is enforced at the data layer and multi-statement handlers are atomic.

**Rule:** the transaction MUST commit (status <400) or roll back (status >=400) BEFORE any response byte reaches the client.
**Why:** committing on socket-finish/close (after the 2xx is already sent) means a commit failure silently loses a write the client was told succeeded. Two review gates failed on this.
**How to apply:** patch the response in the middleware — `res.end` records args + settles the tx but does NOT flush; only after settle do we restore real methods and flush. `res.flushHeaders`/`writeHead` are made non-flushing; 1xx `writeContinue`/`writeEarlyHints` neutralized.

**Streaming is unsupported inside the tenant tx.** `res.write` throws rather than buffering.
**Why:** commit-before-flush is fundamentally incompatible with incremental streaming; buffering chunks instead breaks Node backpressure and risks memory blowup. The whole API uses buffered `res.json`/`res.send` (which call `res.end`, never `res.write`), so the throw never fires in practice — verify with a grep for `res.write|pipe|sendFile|createReadStream` before assuming.

**Liveness safeguards:** a 30s timeout forces rollback + 503 so a hung handler can't pin a pooled connection with an open tx indefinitely; client `close` before settle rolls back; a `terminated` guard prevents double-settle.
