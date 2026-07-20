import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  runInBypassContext,
  usersTable,
  clerkCasesTable,
  type ClerkCorrection,
} from "@workspace/db";
import {
  detectQualityDrop,
  keptRateMonths,
  sweepQualityWatch,
  QUALITY_DROP_ACTION,
  type KeptRateMonth,
} from "./quality-watch.ts";
import { getClerkMetrics } from "./metrics.ts";
import { latestAuditEvent } from "../../test-helpers/audit.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Kept-rate drift watch. Pinned invariants:
//  - detection is pure and conservative: thin months (below the compared-
//  fields floor) are skipped, not compared, and only a material
//  month-over-month kept-rate drop alerts;
//  - the sweep writes ONE audit alert per degraded month (the append-only
//  ledger is the dedup key), so re-runs and extra instances are no-ops;
//  - the health page's trend/banner and the sweep share the same buckets and
//  the same rule, so they can never disagree.

const SALT = makeRunSalt();
const userId = randomUUID();

const month = (m: string, fields: number, keptRate: number): KeptRateMonth => ({
  month: m,
  fields,
  keptRate,
});

const correction = (
  field: string,
  changed: boolean,
): ClerkCorrection => ({
  field,
  extracted: changed ? "old" : "same",
  final: changed ? "new" : "same",
  changed,
});

before(async () => {
  await getDb()
    .insert(usersTable)
    .values({ id: userId, email: `quality-watch-${SALT}@test.example` })
    .onConflictDoNothing();
});

test("detectQualityDrop compares the newest two MEASURED months", () => {
  // A material drop between the two newest measured months alerts.
  const drop = detectQualityDrop([
    month("2026-05", 100, 0.95),
    month("2026-06", 120, 0.7),
  ]);
  assert.ok(drop);
  assert.equal(drop.fromMonth, "2026-05");
  assert.equal(drop.toMonth, "2026-06");
  assert.equal(drop.fromRate, 0.95);
  assert.equal(drop.toRate, 0.7);
  assert.equal(drop.fields, 120, "carries the degraded month's sample size");

  // Thin months (below the sample floor) are skipped, not compared: the
  // degraded month here has 10 fields, so the comparison reaches back to the
  // last real sample and finds no drop.
  assert.equal(
    detectQualityDrop([
      month("2026-04", 100, 0.95),
      month("2026-05", 100, 0.95),
      month("2026-06", 10, 0),
    ]),
    null,
  );

  // A small wobble inside the noise band stays quiet.
  assert.equal(
    detectQualityDrop([month("2026-05", 100, 0.9), month("2026-06", 100, 0.85)]),
    null,
  );
  // Improvement is never an alert.
  assert.equal(
    detectQualityDrop([month("2026-05", 100, 0.7), month("2026-06", 100, 0.95)]),
    null,
  );
  // One measured month has nothing to compare against.
  assert.equal(detectQualityDrop([month("2026-06", 100, 0.5)]), null);
  assert.equal(detectQualityDrop([]), null);

  // Order-insensitive: buckets sort by month before comparing.
  const unsorted = detectQualityDrop([
    month("2026-06", 100, 0.7),
    month("2026-05", 100, 0.95),
  ]);
  assert.ok(unsorted);
  assert.equal(unsorted.toMonth, "2026-06");

  // Explicit thresholds are honoured (the env defaults are just defaults):
  // 5 fields is thin for the default floor of 50, but measured here.
  assert.ok(
    detectQualityDrop(
      [month("2026-05", 5, 0.95), month("2026-06", 5, 0.7)],
      { minFields: 5, dropPoints: 0.1 },
    ),
  );
});

test("keptRateMonths buckets the corrections exhaust by decision month", async () => {
  const beforeMonths = await runInBypassContext(() => keptRateMonths());

  // Two approved extraction cases decided now: 5 compared fields, 3 kept.
  await getDb()
    .insert(clerkCasesTable)
    .values([
      {
        kind: "extraction",
        status: "approved",
        createdBy: userId,
        sourceType: "text",
        sourceName: `qw-a-${SALT}`,
        corrections: [
          correction("invoiceNumber", false),
          correction("grandTotal", true),
          correction("issueDate", false),
        ],
      },
      {
        kind: "extraction",
        status: "approved",
        createdBy: userId,
        sourceType: "text",
        sourceName: `qw-b-${SALT}`,
        corrections: [
          correction("invoiceNumber", false),
          correction("lines.0.vatRate", true),
        ],
      },
      // Rejected and pending cases carry no signal — must not count.
      {
        kind: "extraction",
        status: "rejected",
        createdBy: userId,
        sourceType: "text",
        sourceName: `qw-c-${SALT}`,
        corrections: [correction("invoiceNumber", true)],
      },
    ]);

  const afterMonths = await runInBypassContext(() => keptRateMonths());
  const current = new Date().toISOString().slice(0, 7); // UTC "YYYY-MM"
  const b = beforeMonths.find((m) => m.month === current);
  const a = afterMonths.find((m) => m.month === current);
  assert.ok(a, "the decision month has a bucket");
  assert.equal(a.fields, (b?.fields ?? 0) + 5, "5 compared fields added");
  const keptBefore = b ? Math.round(b.keptRate * b.fields) : 0;
  const keptAfter = Math.round(a.keptRate * a.fields);
  assert.equal(keptAfter, keptBefore + 3, "3 kept (changed=false) added");

  // Buckets are well-formed whatever the shared DB holds.
  for (const m of afterMonths) {
    assert.match(m.month, /^\d{4}-\d{2}$/);
    assert.ok(m.fields > 0, "a bucket only exists for months with fields");
    assert.ok(m.keptRate >= 0 && m.keptRate <= 1);
  }
});

test("the sweep alerts once per degraded month via the audit ledger", async () => {
  // Salted fake months keep this independent of whatever approved cases
  // other test files stored, and unique across repeated local runs.
  const fromMonth = `A-${SALT}`;
  const toMonth = `B-${SALT}`;
  const months = async () => [
    month(fromMonth, 100, 0.95),
    month(toMonth, 100, 0.5),
  ];

  const first = await sweepQualityWatch({ months });
  assert.deepEqual(first, { checked: true, dropped: true, alerted: true });

  const event = await latestAuditEvent(QUALITY_DROP_ACTION, toMonth);
  assert.ok(event, "the drop landed in the audit ledger");
  assert.equal(event.actorId, "quality-watch");
  assert.equal(event.actorRole, "system");
  const after = event.after as {
    fromMonth?: string;
    toRate?: number;
    fields?: number;
  };
  assert.equal(after.fromMonth, fromMonth);
  assert.equal(after.toRate, 0.5);
  assert.equal(after.fields, 100);

  // Second pass (same month pair): the ledger dedups, no second alert.
  const second = await sweepQualityWatch({ months });
  assert.deepEqual(second, { checked: true, dropped: true, alerted: false });

  // No drop: nothing checked out of the ordinary, nothing written.
  const quiet = await sweepQualityWatch({
    months: async () => [month(fromMonth, 100, 0.95), month(toMonth, 100, 0.95)],
  });
  assert.deepEqual(quiet, { checked: true, dropped: false, alerted: false });
});

test("the health page's trend and banner share the sweep's buckets and rule", async () => {
  const metrics = await getClerkMetrics(30);
  const live = await runInBypassContext(() => keptRateMonths());
  // The corrections inserted above guarantee at least one measured month.
  assert.ok(metrics.keptRateTrend, "trend present once the exhaust has months");
  assert.deepEqual(metrics.keptRateTrend, live);
  assert.deepEqual(metrics.qualityAlert ?? null, detectQualityDrop(live));
});
