import { desc, isNotNull, isNull, sql } from "drizzle-orm";
import {
  getDb,
  clerkEvalFixturesTable,
  clerkEvalRunsTable,
  clerkRedTeamFixturesTable,
  type ClerkEvalFixtureResult,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { EVAL_FIXTURES } from "./eval-fixtures";
import { GROWN_CORPUS_CAP } from "./eval-growth";
import { RED_TEAM_CORPUS_CAP } from "./red-team";

// Eval corpus curation (round 15). The corpus grows on two automatic rails —
// corrected approvals (eval-growth.ts) and generated attacks (red-team.ts) —
// but until now nothing let an operator SEE what accumulated or prune a
// fixture that keeps failing for reasons that aren't the model's fault (a
// mis-corrected approval, a nonsense OCR document, a red-team variant whose
// decoys aged badly). This module is that curation surface:
//
//  - listEvalFixtures(): the full corpus inventory — static, grown and
//    red-team — with each fixture's pass history reconstructed by scanning
//    the newest stored eval runs (the append-only evidence; nothing new is
//    stored). Retired fixtures are listed and flagged, so the pruning
//    decision stays reviewable.
//  - retireFixture()/restoreFixture(): flip the retiredAt marker the corpus
//    loaders exclude BEFORE their newest-N caps (retirement frees a slot).
//    The fixture ROW is never deleted — past runs keep their meaning — and
//    static fixtures can never be retired: they are the hand-written
//    regression floor every run must keep measuring.
//
// Everything here is deterministic SQL + in-memory assembly; zero model calls.

// How many recent runs the history reconstruction scans. Each run's results
// jsonb carries one entry per fixture, so this bounds both the query and the
// assembly regardless of how long the platform has been running evals.
const RUN_SCAN_CAP = 50;

export type EvalFixtureSource = "static" | "grown" | "redteam";

// Key prefixes are the loaders' own key scheme: a grown fixture is
// `correction.<first 8 of caseId>` (eval-growth.ts), a red-team variant is
// `redteam.<first 8 of id>` (red-team.ts). Static keys are whatever
// eval-fixtures.ts hand-wrote (e.g. "clean.standard").
const GROWN_KEY_PREFIX = "correction.";
const RED_TEAM_KEY_PREFIX = "redteam.";

export interface EvalFixtureSummary {
  key: string;
  source: EvalFixtureSource;
  label: string;
  riskLabel: string;
  retired: boolean;
  retiredAt: string | null;
  createdAt: string | null;
  // History reconstructed from the scanned runs (field NAMES only — a
  // mismatch's expected/actual values are fixture content and stay in the
  // run rows, never in this inventory).
  runs: number;
  lastOutcome: string | null;
  fieldsCompared: number;
  fieldsCorrect: number;
  injectionFixtures: number;
  injectionResisted: number;
  lastMismatchedFields: string[];
}

export interface EvalFixtureReport {
  fixtures: EvalFixtureSummary[];
  runsScanned: number;
}

interface FixtureHistory {
  runs: number;
  lastOutcome: string | null;
  fieldsCompared: number;
  fieldsCorrect: number;
  injectionFixtures: number;
  injectionResisted: number;
  lastMismatchedFields: string[];
}

const EMPTY_HISTORY: FixtureHistory = {
  runs: 0,
  lastOutcome: null,
  fieldsCompared: 0,
  fieldsCorrect: 0,
  injectionFixtures: 0,
  injectionResisted: 0,
  lastMismatchedFields: [],
};

// Fold the scanned runs (newest first) into per-key cumulative history. The
// first appearance of a key is its newest, so lastOutcome and
// lastMismatchedFields come from that entry; everything else accumulates.
function reconstructHistory(
  runs: Array<{ results: ClerkEvalFixtureResult[] }>,
): Map<string, FixtureHistory> {
  const byKey = new Map<string, FixtureHistory>();
  for (const run of runs) {
    for (const result of run.results) {
      let history = byKey.get(result.key);
      if (!history) {
        history = {
          ...EMPTY_HISTORY,
          lastOutcome: result.outcome,
          lastMismatchedFields: result.mismatches.map((m) => m.field),
        };
        byKey.set(result.key, history);
      }
      history.runs += 1;
      history.fieldsCompared += result.fieldsCompared;
      history.fieldsCorrect += result.fieldsCorrect;
      if (result.injectionResisted !== null) {
        history.injectionFixtures += 1;
        if (result.injectionResisted) history.injectionResisted += 1;
      }
    }
  }
  return byKey;
}

export async function listEvalFixtures(): Promise<EvalFixtureReport> {
  const db = getDb();

  // The ACTIVE side of each stored corpus is exactly what the loaders run:
  // newest-N unretired (same order, same cap). Retired rows are listed in
  // full — they are operator-curated and stay visible for restore.
  const grownActive = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(isNull(clerkEvalFixturesTable.retiredAt))
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(GROWN_CORPUS_CAP);
  const grownRetired = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(isNotNull(clerkEvalFixturesTable.retiredAt))
    .orderBy(desc(clerkEvalFixturesTable.createdAt));
  const redActive = await db
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(isNull(clerkRedTeamFixturesTable.retiredAt))
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt))
    .limit(RED_TEAM_CORPUS_CAP);
  const redRetired = await db
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(isNotNull(clerkRedTeamFixturesTable.retiredAt))
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt));

  const runs = await db
    .select({ results: clerkEvalRunsTable.results })
    .from(clerkEvalRunsTable)
    .orderBy(desc(clerkEvalRunsTable.createdAt))
    .limit(RUN_SCAN_CAP);
  const history = reconstructHistory(runs);

  const withHistory = (
    base: Omit<EvalFixtureSummary, keyof FixtureHistory>,
  ): EvalFixtureSummary => ({
    ...base,
    ...(history.get(base.key) ?? EMPTY_HISTORY),
  });

  const fixtures: EvalFixtureSummary[] = [
    ...EVAL_FIXTURES.map((f) =>
      withHistory({
        key: f.key,
        source: "static",
        label: f.label,
        riskLabel: f.riskLabel,
        retired: false,
        retiredAt: null,
        createdAt: null,
      }),
    ),
    ...[...grownActive, ...grownRetired].map((r) =>
      withHistory(grownSummaryBase(r)),
    ),
    ...[...redActive, ...redRetired].map((r) =>
      withHistory(redTeamSummaryBase(r)),
    ),
  ];

  return { fixtures, runsScanned: runs.length };
}

type GrownRow = typeof clerkEvalFixturesTable.$inferSelect;
type RedTeamRow = typeof clerkRedTeamFixturesTable.$inferSelect;

// Row → summary base, using the SAME key/label scheme as the loaders so the
// inventory's keys line up with the keys stored in every run's results.
function grownSummaryBase(
  row: GrownRow,
): Omit<EvalFixtureSummary, keyof FixtureHistory> {
  return {
    key: `${GROWN_KEY_PREFIX}${row.caseId.slice(0, 8)}`,
    source: "grown",
    label: row.label,
    riskLabel: "correction",
    retired: row.retiredAt !== null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function redTeamSummaryBase(
  row: RedTeamRow,
): Omit<EvalFixtureSummary, keyof FixtureHistory> {
  return {
    key: `${RED_TEAM_KEY_PREFIX}${row.id.slice(0, 8)}`,
    source: "redteam",
    label: `red team: ${row.strategy} (from ${row.baseKey})`,
    riskLabel: "injection",
    retired: row.retiredAt !== null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// Map a fixture key back to its stored row. The key embeds only the first 8
// hex chars of the underlying uuid, so the lookup matches on that prefix —
// unique in practice (the loaders would collide on display before we would
// here) and newest-first so a freak collision resolves deterministically.
async function findGrownRow(idPrefix: string): Promise<GrownRow | null> {
  const [row] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(sql`left(${clerkEvalFixturesTable.caseId}::text, 8) = ${idPrefix}`)
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(1);
  return row ?? null;
}

async function findRedTeamRow(idPrefix: string): Promise<RedTeamRow | null> {
  const [row] = await getDb()
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(sql`left(${clerkRedTeamFixturesTable.id}::text, 8) = ${idPrefix}`)
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt))
    .limit(1);
  return row ?? null;
}

function assertNotStatic(key: string): void {
  if (EVAL_FIXTURES.some((f) => f.key === key)) {
    throw new DomainError(
      "STATIC_FIXTURE",
      "Static fixtures are the hand-written regression floor and cannot be retired",
      400,
    );
  }
}

async function setRetired(
  key: string,
  actorId: string,
  retire: boolean,
): Promise<EvalFixtureSummary> {
  assertNotStatic(key);
  const action = retire ? "clerk.eval.fixture.retire" : "clerk.eval.fixture.restore";

  if (key.startsWith(GROWN_KEY_PREFIX)) {
    const row = await findGrownRow(key.slice(GROWN_KEY_PREFIX.length));
    if (!row) throw new DomainError("NOT_FOUND", "Fixture not found", 404);
    // Idempotent: retiring keeps the original retirement timestamp.
    const retiredAt = retire ? (row.retiredAt ?? new Date()) : null;
    const [updated] = await getDb()
      .update(clerkEvalFixturesTable)
      .set({ retiredAt })
      .where(sql`${clerkEvalFixturesTable.id} = ${row.id}`)
      .returning();
    await appendAudit({
      actorId,
      action,
      entityType: "clerk_eval_fixture",
      entityId: row.id,
      before: { retiredAt: row.retiredAt?.toISOString() ?? null },
      after: { key, retiredAt: retiredAt?.toISOString() ?? null },
    });
    return { ...grownSummaryBase(updated), ...EMPTY_HISTORY };
  }

  if (key.startsWith(RED_TEAM_KEY_PREFIX)) {
    const row = await findRedTeamRow(key.slice(RED_TEAM_KEY_PREFIX.length));
    if (!row) throw new DomainError("NOT_FOUND", "Fixture not found", 404);
    const retiredAt = retire ? (row.retiredAt ?? new Date()) : null;
    const [updated] = await getDb()
      .update(clerkRedTeamFixturesTable)
      .set({ retiredAt })
      .where(sql`${clerkRedTeamFixturesTable.id} = ${row.id}`)
      .returning();
    await appendAudit({
      actorId,
      action,
      entityType: "clerk_red_team_fixture",
      entityId: row.id,
      before: { retiredAt: row.retiredAt?.toISOString() ?? null },
      after: { key, retiredAt: retiredAt?.toISOString() ?? null },
    });
    return { ...redTeamSummaryBase(updated), ...EMPTY_HISTORY };
  }

  // Neither a known static key nor a curatable prefix.
  throw new DomainError("NOT_FOUND", "Fixture not found", 404);
}

export async function retireFixture(
  key: string,
  actorId: string,
): Promise<EvalFixtureSummary> {
  return setRetired(key, actorId, true);
}

export async function restoreFixture(
  key: string,
  actorId: string,
): Promise<EvalFixtureSummary> {
  return setRetired(key, actorId, false);
}
