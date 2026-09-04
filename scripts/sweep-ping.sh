#!/usr/bin/env sh
# Wake-up ping for the Autoscale API deployment (SME-08 reliability).
#
# The published API server runs on Replit Autoscale, which scales to zero when
# idle — freezing the in-process worker timers (outbox drain, reconciliation,
# and the 1-minute B2C compliance sweep that fires pre-breach alerts). This
# script pings the token-protected sweep trigger, which wakes an instance and
# runs one full pass of that timer work synchronously before responding.
#
# Intended to be run every ~5 minutes by a Replit Scheduled Deployment (or any
# external cron). The pre-breach alert margin is 4 hours, so a 5-minute cadence
# leaves ample headroom. The endpoint is idempotent and safe to over-call.
#
# Usage: SWEEP_TOKEN=... ./scripts/sweep-ping.sh
# The Node pinger signs every call, including a legacy single-token deployment
# (key id `legacy`), so production can keep OP_LEGACY_TOKENS off.
set -eu
exec node "$(dirname "$0")/src/ops/sweep-ping.mjs"
