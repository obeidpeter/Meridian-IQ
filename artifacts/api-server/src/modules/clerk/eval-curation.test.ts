import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  usersTable,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkEvalRunsTable,
  clerkRedTeamFixturesTable,
  type ClerkEvalFixtureResult,
} from "@workspace/db";
import { ListEvalFixturesResponse } from "@workspace/api-zod";
import {
  listEvalFixtures,
  retireFixture,
  restoreFixture,
} from "./eval-curation.ts";
import { loadGrownFixtures } from "./eval-growth.ts";
import { loadRedTeamFixtures } from "./red-team.ts";
import { DomainError } from "../errors.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Eval corpus curation (round 15). Invariants pinned here:
//  - retirement excludes a fixture from the corpus loaders BEFORE the
//    newest-N cap, so a retired fixture frees its slot for the next most
//    recent one — and restore puts it back;
//  - static fixtures are the hand-written regression floor: 400, never
//    retirable; unknown keys 404;
//  - the inventory lists retired fixtures flagged, and reconstructs each
//    fixture's pass history from the stored (append-only) eval runs — field
//    NAMES only, no values.

const SALT = makeRunSalt();
const userId = randomUUID();
const caseIds = [randomUUID(), randomUUID(), randomUUID()];
const redTeamId = randomUUID();

// Future-dated createdAt: the shared scratch DB accumulates grown fixtures
// from other suites, and the loaders order newest-first — a fixed offset
// guarantees THESE rows are the newest during this file's run.
const base = Date.now() + 60_000;
const at = (i: number) => new Date(base + i * 1_000);

const keyFor = (caseId: string) => `correction.${caseId.slice(0, 8)}`;
const redKey = `redteam.${redTeamId.slice(0, 8)}`;

function runResult(
  over: Partial<ClerkEvalFixtureResult> & { key: string },
): ClerkEvalFixtureResult {
  return {
    label: "t",
    riskLabel: "correction",
    outcome: "ok",
    fieldsCompared: 0,
    fieldsCorrect: 0,
    mismatches: [],
    injectionResisted: null,
    ...over,
  };
}

async function seedRun(
  results: ClerkEvalFixtureResult[],
  createdAt: Date,
): Promise<void> {
  await getDb()
    .insert(clerkEvalRunsTable)
    .values({
      startedBy: null,
      model: `curation-test-${SALT}`,
      promptVersion: "extract.test",
      fixtureCount: results.length,
      fieldsCompared: results.reduce((s, r) => s + r.fieldsCompared, 0),
      fieldsCorrect: results.reduce((s, r) => s + r.fieldsCorrect, 0),
      injectionFixtures: results.filter((r) => r.injectionResisted !== null)
        .length,
      injectionResisted: results.filter((r) => r.injectionResisted === true)
        .length,
      results,
      durationMs: 1,
      createdAt,
    });
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `eval-curation-${SALT}@test.example` });
  await db.insert(clerkCasesTable).values(
    caseIds.map((id, i) => ({
      id,
      kind: "extraction" as const,
      status: "approved" as const,
      sourceType: "text" as const,
      sourceName: `curation-${SALT}-${i}.txt`,
      sourceText: `INVOICE CURATION-${SALT}-${i}`,
      createdBy: userId,
    })),
  );
  await db.insert(clerkEvalFixturesTable).values(
    caseIds.map((caseId, i) => ({
      caseId,
      label: `curation fixture ${SALT} #${i}`,
      sourceText: `INVOICE CURATION-${SALT}-${i}`,
      expected: { invoiceNumber: `CUR-${i}` },
      createdAt: at(i),
    })),
  );
  await db.insert(clerkRedTeamFixturesTable).values({
    id: redTeamId,
    baseKey: "clean.standard",
    strategy: `curation test ${SALT}`,
    sourceText: `INVOICE + planted instruction ${SALT}`,
    expected: { grandTotal: "215000.00" },
    decoys: { grandTotal: "1.00" },
    createdAt: at(0),
  });
});

after(async () => {
  // Fixture and case rows are deletable (no append-only trigger; runs are
  // not, and simply stay as inert evidence). Keep the shared DB clean so the
  // future-dated rows never shadow another suite's newest-N expectations.
  const db = getDb();
  await db
    .delete(clerkEvalFixturesTable)
    .where(inArray(clerkEvalFixturesTable.caseId, caseIds));
  await db
    .delete(clerkRedTeamFixturesTable)
    .where(eq(clerkRedTeamFixturesTable.id, redTeamId));
  await db.delete(clerkCasesTable).where(inArray(clerkCasesTable.id, caseIds));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

test("retire excludes a grown fixture before the cap (slot freed); restore returns it", async () => {
  // Newest two of the three seeded fixtures fill a cap of 2.
  const initial = (await loadGrownFixtures(2)).map((f) => f.key);
  assert.deepEqual(initial, [keyFor(caseIds[1]), keyFor(caseIds[2])]);

  const retired = await retireFixture(keyFor(caseIds[2]), userId);
  assert.equal(retired.retired, true);
  assert.equal(retired.source, "grown");
  assert.ok(retired.retiredAt, "retiredAt is stamped");

  // The retired newest is gone AND the oldest moved into the freed slot —
  // exclusion happens before the cap, not as a post-filter.
  const afterRetire = (await loadGrownFixtures(2)).map((f) => f.key);
  assert.deepEqual(afterRetire, [keyFor(caseIds[0]), keyFor(caseIds[1])]);

  // Retire is idempotent: the original timestamp survives a second call.
  const again = await retireFixture(keyFor(caseIds[2]), userId);
  assert.equal(again.retiredAt, retired.retiredAt);

  const restored = await restoreFixture(keyFor(caseIds[2]), userId);
  assert.equal(restored.retired, false);
  assert.equal(restored.retiredAt, null);
  assert.deepEqual(
    (await loadGrownFixtures(2)).map((f) => f.key),
    initial,
  );
});

test("retire excludes a red-team variant from its loader; restore returns it", async () => {
  const has = async () =>
    (await loadRedTeamFixtures()).some((f) => f.key === redKey);
  assert.equal(await has(), true);

  const retired = await retireFixture(redKey, userId);
  assert.equal(retired.source, "redteam");
  assert.equal(retired.retired, true);
  assert.equal(await has(), false);

  await restoreFixture(redKey, userId);
  assert.equal(await has(), true);
});

test("static fixtures cannot be retired (400); unknown keys 404", async () => {
  await assert.rejects(
    () => retireFixture("clean.standard", userId),
    (err: unknown) => err instanceof DomainError && err.status === 400,
  );
  await assert.rejects(
    () => restoreFixture("clean.standard", userId),
    (err: unknown) => err instanceof DomainError && err.status === 400,
  );
  // 'zz' is not valid uuid hex, so these prefixes can never match a row.
  for (const key of ["correction.zzzzzzzz", "redteam.zzzzzzzz", "bogus.key"]) {
    await assert.rejects(
      () => retireFixture(key, userId),
      (err: unknown) => err instanceof DomainError && err.status === 404,
      `${key} must 404`,
    );
  }
});

test("listEvalFixtures reconstructs history from stored runs and flags retirement", async () => {
  const grownKey = keyFor(caseIds[0]);
  // Older run: a mismatch on grandTotal, and the red-team variant resisted.
  await seedRun(
    [
      runResult({
        key: grownKey,
        fieldsCompared: 5,
        fieldsCorrect: 4,
        mismatches: [
          { field: "grandTotal", expected: "100", actual: "1" },
        ],
      }),
      runResult({
        key: redKey,
        riskLabel: "injection",
        fieldsCompared: 3,
        fieldsCorrect: 3,
        injectionResisted: true,
      }),
    ],
    new Date(),
  );
  // Newer run: clean pass for the grown fixture; the variant fails closed.
  await seedRun(
    [
      runResult({ key: grownKey, fieldsCompared: 5, fieldsCorrect: 5 }),
      runResult({
        key: redKey,
        riskLabel: "injection",
        outcome: "error",
        injectionResisted: false,
      }),
    ],
    new Date(Date.now() + 1_000),
  );

  const report = await listEvalFixtures();
  assert.ok(report.runsScanned >= 2, "both seeded runs were scanned");

  // The report parses against the contract's response validator.
  ListEvalFixturesResponse.parse(report);

  // Static fixtures are present, never retirable, source "static".
  const staticRow = report.fixtures.find((f) => f.key === "clean.standard");
  assert.ok(staticRow);
  assert.equal(staticRow.source, "static");
  assert.equal(staticRow.retired, false);
  assert.equal(staticRow.createdAt, null);

  // Cumulative history for the grown fixture, newest run first: lastOutcome
  // and lastMismatchedFields come from the newest appearance, counters sum.
  const grown = report.fixtures.find((f) => f.key === grownKey);
  assert.ok(grown);
  assert.equal(grown.source, "grown");
  assert.equal(grown.runs, 2);
  assert.equal(grown.lastOutcome, "ok");
  assert.equal(grown.fieldsCompared, 10);
  assert.equal(grown.fieldsCorrect, 9);
  assert.deepEqual(grown.lastMismatchedFields, []);

  // Injection accounting for the red-team variant: scored twice, resisted
  // once; the newest appearance sets lastOutcome. Field names only — the
  // inventory never carries mismatch values.
  const red = report.fixtures.find((f) => f.key === redKey);
  assert.ok(red);
  assert.equal(red.source, "redteam");
  assert.equal(red.riskLabel, "injection");
  assert.equal(red.runs, 2);
  assert.equal(red.lastOutcome, "error");
  assert.equal(red.injectionFixtures, 2);
  assert.equal(red.injectionResisted, 1);

  // A retired fixture stays in the inventory, flagged.
  await retireFixture(grownKey, userId);
  try {
    const after = await listEvalFixtures();
    const flagged = after.fixtures.find((f) => f.key === grownKey);
    assert.ok(flagged, "retired fixtures are still listed");
    assert.equal(flagged.retired, true);
    assert.ok(flagged.retiredAt);
    // History stays attached to the retired row — the runs remain evidence.
    assert.equal(flagged.runs, 2);
  } finally {
    await restoreFixture(grownKey, userId);
  }
});
