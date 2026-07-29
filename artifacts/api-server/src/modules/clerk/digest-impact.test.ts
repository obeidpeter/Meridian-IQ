import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, clerkDigestsTable, firmsTable } from "@workspace/db";
import { computeDigestImpact } from "./digest-impact.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Digest impact report (round-20 idea #6). Pinned invariants:
//  - the time series is the digests' OWN stored fact snapshots; rows
//    without facts (pre-round-20) never contribute;
//  - only pairs exactly 7 days apart count — a skipped week is not a
//    week-over-week observation;
//  - the split is by whether the EARLIER digest of the pair was delivered;
//  - buckets under the pair floor show null rates, and the note pins
//    correlation-not-causation.

const SALT = makeRunSalt();
const firmDelivered = randomUUID();
const firmDark = randomUUID();

// Monday-aligned week starts, oldest first.
function week(n: number): Date {
  return new Date(Date.UTC(2026, 0, 5 + 7 * n));
}

async function seedDigest(
  firmId: string,
  weekNo: number,
  urgent: { overdue: number; failed: number },
  delivered: boolean,
): Promise<void> {
  await getDb().insert(clerkDigestsTable).values({
    firmId,
    weekStart: week(weekNo),
    headline: `w${weekNo} ${SALT}`,
    bullets: [],
    source: "template",
    facts: { overdueCount: urgent.overdue, failedCount: urgent.failed },
    deliveredAt: delivered ? new Date() : null,
  });
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmDelivered, name: `DI Delivered ${SALT}` },
    { id: firmDark, name: `DI Dark ${SALT}` },
  ]);
  // Delivered firm: urgent falls 6 → 4 → 4 → 1 (3 pairs; improved in 2).
  await seedDigest(firmDelivered, 0, { overdue: 4, failed: 2 }, true);
  await seedDigest(firmDelivered, 1, { overdue: 3, failed: 1 }, true);
  await seedDigest(firmDelivered, 2, { overdue: 3, failed: 1 }, true);
  await seedDigest(firmDelivered, 3, { overdue: 1, failed: 0 }, true);
  // A gap: week 5 (week 4 missing) — the (3,5) pair must NOT count.
  await seedDigest(firmDelivered, 5, { overdue: 0, failed: 0 }, true);
  // Dark firm: never delivered, urgent grows 2 → 3 → 5 → 6 (3 pairs, 0 improved).
  await seedDigest(firmDark, 0, { overdue: 1, failed: 1 }, false);
  await seedDigest(firmDark, 1, { overdue: 2, failed: 1 }, false);
  await seedDigest(firmDark, 2, { overdue: 4, failed: 1 }, false);
  await seedDigest(firmDark, 3, { overdue: 5, failed: 1 }, false);
  // A null-facts legacy row inside the run: contributes nothing, and must
  // not break the 7-day chain arithmetic for rows around it.
  await getDb().insert(clerkDigestsTable).values({
    firmId: firmDark,
    weekStart: week(5),
    headline: `legacy ${SALT}`,
    bullets: [],
    source: "template",
    facts: null,
  });
});

test("consecutive snapshot pairs split by delivery", async () => {
  // The two seeded firms only (the hook keeps the shared DB out).
  const delivered = await computeDigestImpact(firmDelivered);
  assert.equal(delivered.delivered.pairs, 3, "the week-4 gap pair is excluded");
  assert.ok(
    delivered.delivered.meanUrgentDelta !== null &&
      Math.abs(delivered.delivered.meanUrgentDelta - (-5 / 3)) < 1e-9,
    `mean delta ${delivered.delivered.meanUrgentDelta} — (−2, 0, −3)/3`,
  );
  assert.ok(
    delivered.delivered.improvedShare !== null &&
      Math.abs(delivered.delivered.improvedShare - 2 / 3) < 1e-9,
  );
  assert.equal(delivered.undelivered.pairs, 0);
  assert.match(delivered.note, /Correlation, not causation/);

  const dark = await computeDigestImpact(firmDark);
  assert.equal(dark.undelivered.pairs, 3);
  assert.equal(dark.undelivered.improvedShare, 0, "urgent only grew");
  assert.ok(
    dark.undelivered.meanUrgentDelta !== null &&
      dark.undelivered.meanUrgentDelta > 0,
  );
});

test("a bucket under the pair floor shows counts but no rates", async () => {
  const report = await computeDigestImpact(randomUUID());
  assert.equal(report.delivered.pairs, 0);
  assert.equal(report.delivered.meanUrgentDelta, null);
  assert.equal(report.delivered.improvedShare, null);
});
