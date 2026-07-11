#!/usr/bin/env sh
# Wake-up ping for the Autoscale API deployment (SME-08 reliability).
#
# The published API server runs on Replit Autoscale, which scales to zero when
# idle — freezing the in-process worker timers (outbox drain, reconciliation,
# and the 1-minute B2C compliance sweep that fires pre-breach alerts). This
# script pings the public sweep trigger, which wakes an instance and runs one
# full pass of that timer work synchronously before responding.
#
# Intended to be run every ~5 minutes by a Replit Scheduled Deployment (or any
# external cron). The pre-breach alert margin is 4 hours, so a 5-minute cadence
# leaves ample headroom. The endpoint is idempotent and safe to over-call.
#
# Usage:
#   ./scripts/sweep-ping.sh                       # pings the production URL
#   SWEEP_URL=https://example.com/api/internal/sweep ./scripts/sweep-ping.sh
set -eu

SWEEP_URL="${SWEEP_URL:-https://meridian-iq.replit.app/api/internal/sweep}"

# --max-time bounds a hung request; --retry covers cold-start flakiness
# (connection resets while the instance is waking).
curl -fsS --max-time 120 --retry 3 --retry-delay 5 --retry-all-errors "$SWEEP_URL"
echo
