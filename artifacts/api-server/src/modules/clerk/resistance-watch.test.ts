import { test } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq } from "drizzle-orm";
import { getDb, runInBypassContext, auditEventsTable } from "@workspace/db";
import {
  detectResistanceDrop,
  injectionResistanceMonths,
  sweepResistanceWatch,
  RESISTANCE_DROP_ACTION,
  type ResistanceMonth,
} from "./resistance-watch.ts";
import { getClerkMetrics } from "./metrics.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Resistance-drop alert (round-8 idea #2). Pinned invariants:
//  - detection is pure and conservative: thin months are skipped, not
//  compared, and only a material month-over-month drop alerts;
//  - the sweep writes ONE audit alert per degraded month (the append-only
//  ledger is the dedup key), so re-runs and extra instances are no-ops;
//  - the health page's banner and the sweep share the same rule, so they can
//  never disagree.

const SALT = makeRunSalt();

const month = (
  m: string,
  injectionFixtures: number,
  injectionResisted: number,
): ResistanceMonth => ({ month: m, runs: 1, injectionFixtures, injectionResisted });

test("detectResistanceDrop compares the newest two MEASURED months", () => {
  // A material drop between the two newest measured months alerts.
  const drop = detectResistanceDrop([
    month("2026-05", 20, 19),
    month("2026-06", 20, 14),
  ]);
  assert.ok(drop);
  assert.equal(drop.fromMonth, "2026-05");
  assert.equal(drop.toMonth, "2026-06");
  assert.equal(drop.fromRate, 0.95);
  assert.equal(drop.toRate, 0.7);
  assert.equal(drop.injectionFixtures, 20);

  // Thin months (below the sample floor) are skipped, not compared: the
  // degraded month here has 3 fixtures, so the comparison reaches back to
  // the last real sample and finds no drop.
  assert.equal(
    detectResistanceDrop([
      month("2026-04", 20, 19),
      month("2026-05", 20, 19),
      month("2026-06", 3, 0),
    ]),
    null,
  );

  // A small wobble inside the noise band stays quiet.
  assert.equal(
    detectResistanceDrop([month("2026-05", 20, 19), month("2026-06", 20, 18)]),
    null,
  );
  // Improvement is never an alert.
  assert.equal(
    detectResistanceDrop([month("2026-05", 20, 14), month("2026-06", 20, 19)]),
    null,
  );
  // One measured month has nothing to compare against.
  assert.equal(detectResistanceDrop([month("2026-06", 20, 10)]), null);
  assert.equal(detectResistanceDrop([]), null);

  // Order-insensitive: buckets sort by month before comparing.
  const unsorted = detectResistanceDrop([
    month("2026-06", 20, 14),
    month("2026-05", 20, 19),
  ]);
  assert.ok(unsorted);
  assert.equal(unsorted.toMonth, "2026-06");
});

test("the sweep alerts once per degraded month via the audit ledger", async () => {
  // Salted fake months keep this independent of whatever eval runs other
  // test files stored, and unique across repeated local runs.
  const fromMonth = `A-${SALT}`;
  const toMonth = `B-${SALT}`;
  const months = async () => [
    month(fromMonth, 20, 19),
    month(toMonth, 20, 10),
  ];

  const first = await sweepResistanceWatch({ months });
  assert.deepEqual(first, { checked: true, dropped: true, alerted: true });

  const [event] = await runInBypassContext(() =>
    getDb()
      .select({
        entityId: auditEventsTable.entityId,
        after: auditEventsTable.after,
      })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, RESISTANCE_DROP_ACTION),
          eq(auditEventsTable.entityId, toMonth),
        ),
      )
      .orderBy(desc(auditEventsTable.seq))
      .limit(1),
  );
  assert.ok(event, "the drop landed in the audit ledger");
  assert.equal((event.after as { fromMonth?: string }).fromMonth, fromMonth);
  assert.equal((event.after as { toRate?: number }).toRate, 0.5);

  // Second pass (same month pair): the ledger dedups, no second alert.
  const second = await sweepResistanceWatch({ months });
  assert.deepEqual(second, { checked: true, dropped: true, alerted: false });

  // No drop: nothing checked out of the ordinary, nothing written.
  const quiet = await sweepResistanceWatch({
    months: async () => [month(fromMonth, 20, 19), month(toMonth, 20, 19)],
  });
  assert.deepEqual(quiet, { checked: true, dropped: false, alerted: false });
});

test("the health banner and the sweep share one rule", async () => {
  const metrics = await getClerkMetrics(30);
  const live = detectResistanceDrop(
    await runInBypassContext(() => injectionResistanceMonths()),
  );
  assert.deepEqual(metrics.resistanceAlert ?? null, live);
});
