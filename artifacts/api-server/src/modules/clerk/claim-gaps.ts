import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Claim-gap mining. Every Ask Clerk refusal is already stored on its question
// case (ask.ts writes answered:false plus a refusalReason built from a fixed
// catalogue of sentences), so the register's demand signal — what firms keep
// asking that the approved claims register cannot answer — is pure SQL plus
// string matching over data the platform already has. Zero model calls,
// nothing stored: the operator reads the report and grows the register (or
// the data-intent catalogue) through the ordinary maker-checker flow.
//
// The matcher keys on distinctive stable substrings of the refusal sentences
// ask.ts actually produces; the claim-gaps test pins every sentence to its
// code, so a reworded refusal fails the test rather than silently landing in
// "other".

const UNCOVERED_CAP = 20;

// The sentence that marks a question OUTSIDE both catalogues — the model
// classified it fine but no approved claim covers it. These are the register
// gaps worth reading verbatim, so the needle is shared with the uncovered
// query below.
const NO_MATCHING_CLAIM_NEEDLE = "not covered by an approved claim";

// Ordered, first match wins. None of the fixed needles appear in another
// sentence, so order only matters for readability.
const REASON_MATCHERS: ReadonlyArray<{ code: string; needle: string }> = [
  { code: "no_active_claims", needle: "no active claims yet" },
  { code: "classification_failed", needle: "could not be classified reliably" },
  { code: "no_matching_claim", needle: NO_MATCHING_CLAIM_NEEDLE },
  {
    code: "month_unresolved",
    needle: "month in the question could not be resolved",
  },
  { code: "month_not_supported", needle: "cannot be filtered to a month" },
  {
    code: "client_unresolved",
    needle: "client named in the question could not be resolved",
  },
  { code: "client_not_supported", needle: "cannot be filtered to one client" },
  { code: "lookup_failed", needle: "firm-record lookup failed" },
  { code: "ambiguous_claims", needle: "exactly one active claim" },
];

// Map a stored refusalReason to its stable cause code. Pure and total: the
// category-mismatch sentence is dynamic ("...applies to B2B transactions,
// but the question appears to be about..."), so it is matched on its fixed
// fragments; anything unrecognized is "other", never an error.
export function refusalCode(reason: string): string {
  for (const { code, needle } of REASON_MATCHERS) {
    if (reason.includes(needle)) return code;
  }
  if (reason.includes("applies to") && reason.includes("transactions")) {
    return "category_mismatch";
  }
  return "other";
}

export interface ClaimGapReport {
  windowDays: number;
  totalQuestions: number;
  refusedTotal: number;
  byReason: { code: string; count: number }[];
  uncovered: { question: string; firmName: string | null; createdAt: Date }[];
}

// Platform-wide by design (like the metrics endpoint that shares its gate):
// the register is global reference data, so its gaps are read across firms.
// Operator requests run in the bypass RLS context; question text is shown to
// operators exactly as the review queue already shows it.
export async function computeClaimGaps(
  windowDays = 90,
): Promise<ClaimGapReport> {
  const db = getDb();
  const since = sql`now() - make_interval(days => ${windowDays})`;

  const [totals] = (
    await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (answer ->> 'answered') = 'false')::int
          AS refused
      FROM clerk_cases
      WHERE created_at >= ${since} AND kind = 'question'
    `)
  ).rows as { total: number; refused: number }[];

  // Distinct refusal sentences are a small closed set (the dynamic
  // category-mismatch sentence varies only by category), so group in SQL and
  // fold the codes in the app — the matcher stays one function.
  const reasonRows = (
    await db.execute(sql`
      SELECT answer ->> 'refusalReason' AS reason, COUNT(*)::int AS count
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'question'
        AND (answer ->> 'answered') = 'false'
      GROUP BY 1
    `)
  ).rows as { reason: string | null; count: number }[];

  const byCode = new Map<string, number>();
  for (const row of reasonRows) {
    const code = row.reason ? refusalCode(row.reason) : "other";
    byCode.set(code, (byCode.get(code) ?? 0) + row.count);
  }
  const byReason = [...byCode.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  // The demand signal: newest questions no approved claim covers. The needle
  // is the same constant the matcher uses, so SQL and app can never disagree
  // about which refusals are "uncovered". firmName is null for operator asks
  // (no tenant on the case).
  const uncoveredRows = (
    await db.execute(sql`
      SELECT c.question, f.name AS firm_name, c.created_at
      FROM clerk_cases c
      LEFT JOIN firms f ON f.id = c.firm_id
      WHERE c.created_at >= ${since}
        AND c.kind = 'question'
        AND (c.answer ->> 'answered') = 'false'
        AND (c.answer ->> 'refusalReason') LIKE ${`%${NO_MATCHING_CLAIM_NEEDLE}%`}
      ORDER BY c.created_at DESC
      LIMIT ${UNCOVERED_CAP}
    `)
  ).rows as {
    question: string | null;
    firm_name: string | null;
    created_at: string | Date;
  }[];

  return {
    windowDays,
    totalQuestions: totals?.total ?? 0,
    refusedTotal: totals?.refused ?? 0,
    byReason,
    uncovered: uncoveredRows.map((r) => ({
      question: r.question ?? "",
      firmName: r.firm_name,
      createdAt: new Date(r.created_at),
    })),
  };
}
