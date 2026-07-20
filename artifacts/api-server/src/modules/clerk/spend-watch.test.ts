import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runInBypassContext } from "@workspace/db";
import {
  detectSpendAnomalies,
  firmSpendDays,
  sweepSpendWatch,
  SPEND_ANOMALY_ACTION,
  type FirmSpendDay,
} from "./spend-watch.ts";
import { latestAuditEvent } from "../../test-helpers/audit.ts";

// Firm spend anomaly watch. Pinned invariants:
//  - detection is pure and conservative: both gates (absolute floor AND
//  multiplier over the firm's OWN median) must trip, and a firm without a
//  real baseline is skipped, not compared;
//  - the sweep writes ONE audit alert per (firm, day) — the append-only
//  ledger is the dedup key — so re-runs and extra instances are no-ops;
//  - zero model calls anywhere: it is SQL plus arithmetic.

const day = (firmId: string, d: string, tokens: number): FirmSpendDay => ({
  firmId,
  day: d,
  tokens,
});

test("detectSpendAnomalies flags only a genuine spike over a real baseline", () => {
  const firm = "firm-a";

  // Genuine anomaly: baseline median 30k, latest 200k >= max(100k, 5×30k).
  const spike = detectSpendAnomalies([
    day(firm, "2026-07-01", 20_000),
    day(firm, "2026-07-02", 30_000),
    day(firm, "2026-07-03", 40_000),
    day(firm, "2026-07-04", 200_000),
  ]);
  assert.deepEqual(spike, [
    { firmId: firm, day: "2026-07-04", tokens: 200_000, medianTokens: 30_000 },
  ]);

  // Below the absolute floor: 6× the median but under MIN_TOKENS stays
  // quiet — a habit of near-zero makes any use look like a spike.
  assert.deepEqual(
    detectSpendAnomalies([
      day(firm, "2026-07-01", 10_000),
      day(firm, "2026-07-02", 10_000),
      day(firm, "2026-07-03", 10_000),
      day(firm, "2026-07-04", 60_000),
    ]),
    [],
  );

  // Above the floor but below the multiplier (median 50k needs >= 250k):
  // a big day inside the firm's own habit is not an anomaly.
  assert.deepEqual(
    detectSpendAnomalies([
      day(firm, "2026-07-01", 40_000),
      day(firm, "2026-07-02", 50_000),
      day(firm, "2026-07-03", 60_000),
      day(firm, "2026-07-04", 150_000),
    ]),
    [],
  );

  // Insufficient baseline: two other measured days is not a habit, however
  // extreme the latest day looks.
  assert.deepEqual(
    detectSpendAnomalies([
      day(firm, "2026-07-02", 1_000),
      day(firm, "2026-07-03", 1_000),
      day(firm, "2026-07-04", 500_000),
    ]),
    [],
  );
  assert.deepEqual(detectSpendAnomalies([]), []);

  // Even-length baselines take the conventional middle-pair average:
  // [20k, 30k, 40k, 50k] → median 35k → threshold 175k.
  const even = detectSpendAnomalies([
    day(firm, "2026-07-01", 20_000),
    day(firm, "2026-07-02", 30_000),
    day(firm, "2026-07-03", 40_000),
    day(firm, "2026-07-04", 50_000),
    day(firm, "2026-07-05", 180_000),
  ]);
  assert.equal(even.length, 1);
  assert.equal(even[0].medianTokens, 35_000);

  // Order-insensitive and per-firm: the latest day is found by date, and a
  // second firm's quiet days never dilute the first firm's baseline.
  const mixed = detectSpendAnomalies([
    day("firm-b", "2026-07-04", 1_000),
    day(firm, "2026-07-04", 200_000),
    day(firm, "2026-07-02", 30_000),
    day(firm, "2026-07-01", 20_000),
    day(firm, "2026-07-03", 40_000),
    day("firm-b", "2026-07-03", 1_000),
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].firmId, firm);
  assert.equal(mixed[0].day, "2026-07-04");
});

test("the sweep alerts once per (firm, day) via the audit ledger", async () => {
  // A random firm id keeps the (firm, day) dedup key unique across repeated
  // local runs — the ledger and the shared DB persist.
  const firmId = randomUUID();
  const spendDays = async () => [
    day(firmId, "2026-07-01", 20_000),
    day(firmId, "2026-07-02", 30_000),
    day(firmId, "2026-07-03", 40_000),
    day(firmId, "2026-07-04", 200_000),
  ];

  const first = await sweepSpendWatch({ spendDays });
  assert.deepEqual(first, { checked: true, anomalies: 1, alerted: 1 });

  const event = await latestAuditEvent(
    SPEND_ANOMALY_ACTION,
    `${firmId}:2026-07-04`,
  );
  assert.ok(event, "the spike landed in the audit ledger");
  assert.equal((event.after as { tokens?: number }).tokens, 200_000);
  assert.equal((event.after as { medianTokens?: number }).medianTokens, 30_000);

  // Second pass (same spike): the ledger dedups, no second alert.
  const second = await sweepSpendWatch({ spendDays });
  assert.deepEqual(second, { checked: true, anomalies: 1, alerted: 0 });

  // Quiet ledger: nothing detected, nothing written.
  const quiet = await sweepSpendWatch({
    spendDays: async () => [
      day(firmId, "2026-07-01", 20_000),
      day(firmId, "2026-07-02", 30_000),
      day(firmId, "2026-07-03", 40_000),
      day(firmId, "2026-07-05", 35_000),
    ],
  });
  assert.deepEqual(quiet, { checked: true, anomalies: 0, alerted: 0 });
});

test("the live day buckets are well-formed (the brief calls the same pair)", async () => {
  // Smoke over the real SQL: whatever ledger rows other suites stored, every
  // bucket is a (firm, UTC day, non-negative tokens) triple the pure detector
  // accepts — the operator brief's spendAlerts is exactly this composition.
  const days = await runInBypassContext(() => firmSpendDays());
  for (const d of days) {
    assert.equal(typeof d.firmId, "string");
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(d.tokens) && d.tokens >= 0);
  }
  const anomalies = detectSpendAnomalies(days);
  assert.ok(Array.isArray(anomalies));
});
