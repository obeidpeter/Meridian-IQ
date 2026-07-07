---
name: Stamp verification integrity
description: How stamp (IRN/CSID) verification must establish validity in the rails adapter.
---

# Stamp verification must check the source of truth

A stamp CSID is `HMAC(rail_secret, IRN + idempotencyKey)` truncated — the idempotency key is NOT recoverable at verify time, so verification cannot re-derive the CSID from IRN alone.

**Rule:** A stamp is valid **iff** an accepted submission persisted that exact `(irn, csid)` pair in `stamp_records`. Verify by looking it up there. `stamp_verifications` is only a freshness cache of results, not the authority.

**Why:** An earlier implementation validated any 24-char hex string as a real stamp (format-only regex), which meant forged CSIDs passed verification — a false-positive that defeats the whole trust model.

**How to apply:** In `verifyStamp` (artifacts/api-server/src/modules/rails/adapter.ts), check the freshness cache first, else query `stamp_records` for a matching `(irn, csid)`; validity = row exists, rail = row's rail. Never gate validity on string shape.
