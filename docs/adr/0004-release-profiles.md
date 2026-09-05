# ADR 0004: Release profiles — pilot by default, governed on request

Status: Accepted (R105, September 2026)

## Context

R198–R200 built a verified release path for Replit: CI stamps an immutable
build manifest over the seven application trees; Publish stages exactly that
artifact; the API boots in HOLD (health only, 503 to business and readiness
requests) and enters RUN only under an activation permit bound to the
candidate, manifest, target, backup, recovery plan and held evidence. Every
gate is sound, but together they are a ceremony sized for a live tenant base.
For a pre-pilot product they had a concrete cost: production sat in HOLD,
pinned to a rollback revision two merges behind main, and leaving HOLD needed
approvals and evidence files that nobody had reason to produce yet.

## Decision

The promotion adapter has two profiles selected by `RELEASE_PROFILE`:

- **pilot** (the default): Publish verifies the staged CI artifact (source
  tree, tracked-source and schema hashes, the complete seven-app asset
  inventory, the manifest checksum from CI's sidecar or an explicit value),
  the API build syncs the target schema — plain `push`, which fails closed on a
  destructive diff, then the guardrail migrations — and the API starts as RUN.
  `RELEASE_RUNTIME_STATE=HOLD` is a plain maintenance switch. No recovery
  plan, activation permit, held evidence or drained-traffic attestation is
  read. `ops:postdeploy` remains the after-the-fact parity check.
- **governed**: the R198–R200 path unchanged — HOLD by default, permit-bound
  RUN, read-only release preflight with fresh backup and restore-drill
  evidence and semantic catalog parity.

Both profiles keep what actually protects the data: nothing rebuilds, installs
or trusts unverified bytes; production never pushes a destructive schema
change; guardrail migrations are re-asserted at boot; backups and the restore
drill run in CI on every merge.

## Consequences

- A merge to main deploys with one Publish and no evidence files. The
  stale-build banner clears when the promoted API reports the contract version
  the web bundles were built with.
- A destructive schema change stops the Publish build; it needs a reviewed
  versioned migration (or the governed profile's offline bootstrap).
- Switching to `governed` is a configuration change once a live tenant base
  justifies the ceremony; the R198 records under `docs/history/2026-09-r198/`
  describe its evidence contracts.
