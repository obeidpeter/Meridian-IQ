import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Ask-feedback mining (round 7) — the refusal-mining sibling (claim-gaps.ts):
// the asker's own helpfulness ratings on question cases, aggregated into the
// operator's improvement signal. Deterministic SQL over clerk_cases, zero
// model calls, nothing stored. The intent bucket is read from the answer the
// platform itself recorded (answer->>'dataIntent'; claim answers group under
// "register", refusals under "refused") — never from question text.

// Trailing window, mirroring claim-gaps' default: recent enough to reflect
// the catalogue in force, long enough to accumulate signal.
export const ASK_FEEDBACK_WINDOW_DAYS = 90;

// Newest not-helpful questions the operator should actually read.
const RECENT_NOT_HELPFUL_LIMIT = 20;

export interface AskFeedbackReport {
  totals: {
    helpful: number;
    notHelpful: number;
    // Answered but never rated — the denominator gap: a high unrated count
    // means the ratings are a thin sample, not that everything is fine.
    unrated: number;
  };
  byIntent: { intent: string; helpful: number; notHelpful: number }[];
  recentNotHelpful: { caseId: string; question: string; createdAt: string }[];
}

// The one spelling of the intent bucket: a data answer's platform-recorded
// intent key; an answered claim answer groups under "register"; everything
// else (refusals, including still-unanswered ratables) under "refused".
const INTENT_BUCKET = sql`COALESCE(
  answer->>'dataIntent',
  CASE
    WHEN (answer->>'answered')::boolean AND answer->>'claimKey' IS NOT NULL
      THEN 'register'
    ELSE 'refused'
  END
)`;

export async function computeAskFeedback(): Promise<AskFeedbackReport> {
  const db = getDb();
  const windowPredicate = sql`kind = 'question'
    AND created_at >= now() - make_interval(days => ${ASK_FEEDBACK_WINDOW_DAYS})`;

  const [totalsRow] = (
    await db.execute<{
      helpful: number;
      not_helpful: number;
      unrated: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE feedback = 'helpful')::int AS helpful,
        COUNT(*) FILTER (WHERE feedback = 'not_helpful')::int AS not_helpful,
        COUNT(*) FILTER (
          WHERE feedback IS NULL AND (answer->>'answered')::boolean
        )::int AS unrated
      FROM clerk_cases
      WHERE ${windowPredicate}
    `)
  ).rows;

  const intentRows = (
    await db.execute<{
      intent: string;
      helpful: number;
      not_helpful: number;
    }>(sql`
      SELECT
        ${INTENT_BUCKET} AS intent,
        COUNT(*) FILTER (WHERE feedback = 'helpful')::int AS helpful,
        COUNT(*) FILTER (WHERE feedback = 'not_helpful')::int AS not_helpful
      FROM clerk_cases
      WHERE ${windowPredicate} AND feedback IS NOT NULL
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1
    `)
  ).rows;

  const recentRows = (
    await db.execute<{
      id: string;
      question: string | null;
      created_at: string | Date;
    }>(sql`
      SELECT id, question, created_at
      FROM clerk_cases
      WHERE ${windowPredicate} AND feedback = 'not_helpful'
      ORDER BY created_at DESC
      LIMIT ${RECENT_NOT_HELPFUL_LIMIT}
    `)
  ).rows;

  return {
    totals: {
      helpful: Number(totalsRow?.helpful ?? 0),
      notHelpful: Number(totalsRow?.not_helpful ?? 0),
      unrated: Number(totalsRow?.unrated ?? 0),
    },
    byIntent: intentRows.map((r) => ({
      intent: r.intent,
      helpful: Number(r.helpful),
      notHelpful: Number(r.not_helpful),
    })),
    recentNotHelpful: recentRows.map((r) => ({
      caseId: r.id,
      question: r.question ?? "",
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}
