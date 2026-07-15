import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkEvalRunsTable,
  type ClerkCase,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { getClerkGateway } from "./provider";
import { runEvalCorpus } from "./eval";
import type { EvalFixture } from "./eval-fixtures";

// The learning loop (Clerk expansion B). Every approval where the operator
// corrected the model's proposal already leaves labeled ground truth on the
// case (corrections: extracted vs final, per field). This module turns that
// exhaust into eval fixtures — the document text plus the human-approved
// values — and, optionally, runs the eval corpus on a nightly cadence so
// prompt/model changes are measured against real corrected documents, not
// only the hand-written static corpus.
//
// Two independent pieces:
//   1. Fixture growth: free (no model calls), runs on the shared sweep loop.
//   2. Auto-eval: spends real tokens, so it is OPT-IN behind the
//      clerk_auto_eval feature flag (off/missing = fail closed) and runs at
//      most once per UTC day, attributed as startedBy = null.

const AUTO_EVAL_FLAG_KEY = "clerk_auto_eval";
const GROWTH_BATCH = 20;
// Advisory lock so concurrent instances can't grow/run twice in one pass.
const EVAL_GROWTH_LOCK_ID = 731_842;

// Pure: an approved, corrected case → a ground-truth fixture, or null when the
// case can't serve as one (no text source, or nothing was compared). The
// expected values are the operator's FINAL values for every compared field —
// including the ones the model already had right (final === extracted).
export function fixtureFromCase(
  kase: Pick<
    ClerkCase,
    "id" | "sourceName" | "sourceText" | "corrections" | "status"
  >,
): {
  caseId: string;
  label: string;
  sourceText: string;
  expected: Record<string, string | null>;
} | null {
  if (kase.status !== "approved") return null;
  if (!kase.sourceText || !kase.corrections?.length) return null;
  const expected: Record<string, string | null> = {};
  for (const c of kase.corrections) expected[c.field] = c.final;
  return {
    caseId: kase.id,
    label: kase.sourceName ?? `case ${kase.id.slice(0, 8)}`,
    sourceText: kase.sourceText,
    expected,
  };
}

// Fixture rows → the EvalFixture shape the runner scores. The corpus is
// CAPPED at the most recent fixtures: growth is unbounded (one per corrected
// approval, forever), and every fixture is one model call per eval run — an
// uncapped corpus makes the nightly run's cost and duration grow without
// limit. Recent corrections are also the ones most representative of the
// current document mix.
const GROWN_CORPUS_CAP = 200;

export async function loadGrownFixtures(
  limit = GROWN_CORPUS_CAP,
): Promise<EvalFixture[]> {
  const rows = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(limit);
  rows.reverse(); // oldest-first, matching the previous stable run order
  return rows.map((r) => ({
    key: `correction.${r.caseId.slice(0, 8)}`,
    label: r.label,
    riskLabel: "correction" as const,
    sourceText: r.sourceText,
    expected: r.expected as EvalFixture["expected"],
  }));
}

// Turn newly corrected approvals into fixtures (one per case, capped per
// pass). Insert races resolve on the caseId unique constraint.
export async function growEvalFixtures(
  limit = GROWTH_BATCH,
): Promise<number> {
  const candidates = await getDb()
    .select({
      id: clerkCasesTable.id,
      sourceName: clerkCasesTable.sourceName,
      sourceText: clerkCasesTable.sourceText,
      corrections: clerkCasesTable.corrections,
      status: clerkCasesTable.status,
    })
    .from(clerkCasesTable)
    .leftJoin(
      clerkEvalFixturesTable,
      eq(clerkEvalFixturesTable.caseId, clerkCasesTable.id),
    )
    .where(
      and(
        eq(clerkCasesTable.kind, "extraction"),
        eq(clerkCasesTable.status, "approved"),
        isNotNull(clerkCasesTable.sourceText),
        isNotNull(clerkCasesTable.corrections),
        isNull(clerkEvalFixturesTable.id),
      ),
    )
    .limit(limit);

  let grown = 0;
  for (const candidate of candidates) {
    const fixture = fixtureFromCase(candidate as ClerkCase);
    if (!fixture) continue;
    const inserted = await getDb()
      .insert(clerkEvalFixturesTable)
      .values(fixture)
      .onConflictDoNothing({ target: clerkEvalFixturesTable.caseId })
      .returning({ id: clerkEvalFixturesTable.id });
    grown += inserted.length;
  }
  return grown;
}

// True when no auto run (startedBy null) has happened today (UTC).
async function autoEvalDueToday(): Promise<boolean> {
  const [last] = await getDb()
    .select({ createdAt: clerkEvalRunsTable.createdAt })
    .from(clerkEvalRunsTable)
    .where(isNull(clerkEvalRunsTable.startedBy))
    .orderBy(desc(clerkEvalRunsTable.createdAt))
    .limit(1);
  if (!last) return true;
  const today = new Date().toISOString().slice(0, 10);
  return last.createdAt.toISOString().slice(0, 10) !== today;
}

registerSweep(async function sweepEvalGrowth(): Promise<void> {
  // Fixture growth (free, DB-only) runs in a SHORT bypass transaction; the
  // nightly auto-eval — one model call per fixture, potentially minutes of
  // provider time — runs OUTSIDE it. Holding the transaction (and its
  // advisory lock, and a pooled connection) across the whole eval run made a
  // slow provider stall the shared sweep loop and every time-sensitive sweep
  // behind it. The lock still de-duplicates growth within a pass; the eval's
  // once-per-day guard is re-checked here and race losers merely record a
  // second run row (startedBy null), which the due-today check then ignores
  // for the rest of the day.
  const runEval = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${EVAL_GROWTH_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return false;

    const grown = await growEvalFixtures();
    if (grown > 0) {
      logger.info({ grown }, "clerk learning loop: eval fixtures grown");
    }

    // Auto-eval spends tokens: opt-in flag, at most once per UTC day.
    if (!(await isFeatureEnabled(AUTO_EVAL_FLAG_KEY))) return false;
    return autoEvalDueToday();
  });
  if (!runEval) return;

  const gateway = await getClerkGateway();
  const run = await runEvalCorpus(null, gateway);
  logger.info(
    {
      fixtureCount: run.fixtureCount,
      fieldsCorrect: run.fieldsCorrect,
      fieldsCompared: run.fieldsCompared,
    },
    "clerk learning loop: nightly eval run complete",
  );
});
