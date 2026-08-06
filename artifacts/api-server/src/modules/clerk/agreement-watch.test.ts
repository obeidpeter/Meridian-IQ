import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, auditEventsTable } from "@workspace/db";
import {
  detectAgreementDrop,
  RECONCILE_AGREEMENT_DROP_ACTION,
  sweepAgreementWatch,
  type AgreementMonth,
} from "./agreement-watch.ts";
import { src } from "../../test-helpers/source-pins.ts";

// The agreement watch (Prove with Clerk Phase 3). The detector pins carry
// the quality-watch doctrine: thin months are skipped rather than compared,
// two measured months are required, and the sweep alerts exactly once per
// (firm, degraded month) — an operator smoke detector, never a kill switch.

function month(m: string, agreed: number, disagreed: number): AgreementMonth {
  const rate =
    agreed + disagreed === 0
      ? 0
      : Math.round((agreed / (agreed + disagreed)) * 10_000) / 10_000;
  return { month: m, agreed, disagreed, rate };
}

test("detectAgreementDrop: thin months skip, real collapses fire", () => {
  // Clean month-over-month collapse: 95% → 60%.
  const drop = detectAgreementDrop(
    [month("2026-06", 19, 1), month("2026-07", 12, 8)],
    10,
    0.2,
  );
  assert.ok(drop);
  assert.equal(drop.fromMonth, "2026-06");
  assert.equal(drop.toMonth, "2026-07");
  assert.equal(drop.decisions, 20);

  // A thin middle month is SKIPPED, not compared — the collapse is still
  // measured against the last thick month.
  const skipped = detectAgreementDrop(
    [month("2026-05", 19, 1), month("2026-06", 2, 0), month("2026-07", 12, 8)],
    10,
    0.2,
  );
  assert.ok(skipped);
  assert.equal(skipped.fromMonth, "2026-05");

  // Below the drop threshold, or without two measured months: silence.
  assert.equal(
    detectAgreementDrop(
      [month("2026-06", 19, 1), month("2026-07", 17, 3)],
      10,
      0.2,
    ),
    null,
  );
  assert.equal(
    detectAgreementDrop([month("2026-07", 12, 8)], 10, 0.2),
    null,
  );
});

test("the sweep alerts once per degraded month and never re-alerts", async () => {
  const firmId = randomUUID();
  const months = [month("2026-06", 19, 1), month("2026-07", 12, 8)];
  const deps = {
    litFirms: async () => [firmId],
    months: async () => months,
  };
  const first = await sweepAgreementWatch(deps);
  assert.deepEqual(first, { checked: 1, dropped: 1, alerted: 1 });
  const second = await sweepAgreementWatch(deps);
  assert.deepEqual(
    second,
    { checked: 1, dropped: 1, alerted: 0 },
    "the (action, entityId) ledger key dedups re-runs",
  );
  const rows = await getDb()
    .select({ after: auditEventsTable.after, firmId: auditEventsTable.firmId })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, RECONCILE_AGREEMENT_DROP_ACTION),
        eq(auditEventsTable.entityId, `${firmId}:2026-07`),
      ),
    );
  assert.equal(rows.length, 1, "exactly one durable alert row");
  assert.equal(rows[0].firmId, firmId, "firm-stamped for the operator read");
  assert.equal((rows[0].after as { toRate: number }).toRate, 0.6);
});

test("a dark firm is never checked; no sweep writes a feature flag", async () => {
  const result = await sweepAgreementWatch({
    litFirms: async () => [],
    months: async () => {
      throw new Error("months() must not run with no lit firms");
    },
  });
  assert.deepEqual(result, { checked: 0, dropped: 0, alerted: 0 });
  // Doctrine pin: the watch module reads flags, never writes them.
  const source = src("modules/clerk/agreement-watch.ts");
  assert.ok(!source.includes("setFlag"), "no flag writes from a watch");
  assert.ok(!source.includes("setFirmOverride"), "no override writes either");
});

test("the operator Desk can see the new alert class", () => {
  assert.ok(
    src("routes/operator.ts").includes("RECONCILE_AGREEMENT_DROP_ACTION"),
    "the action must join HEALTH_ALERT_ACTIONS or the Desk never shows it — the phrasing-watch gap, not repeated",
  );
  assert.ok(
    src("routes/index.ts").includes('import "../modules/clerk/agreement-watch"'),
    "the module must be side-effect imported or its sweep never registers",
  );
});
