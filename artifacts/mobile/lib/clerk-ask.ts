/**
 * Pure helpers behind the "Ask Clerk" screen: the question bounds shared
 * with the API contract, the vetted client-safe suggested-question chips,
 * and the source-note builders for answers. Kept free of React Native
 * imports so the node:test suite can exercise them directly.
 */

import type { ClerkAnswer } from "@workspace/api-client-react";

// AskClerkInput bounds — mirrored client-side so the Ask button and the
// input's maxLength agree with what the server will accept.
export const QUESTION_MIN = 3;
export const QUESTION_MAX = 2000;

// Pre-phrased to land in the grounded data intents, so a first tap answers
// from the asker's own records instead of a register refusal. This screen
// serves client_users too (SEC-03), who are only offered the
// CLIENT_SAFE_DATA_INTENTS subset (api-server modules/clerk/data-intents.ts)
// — so every chip here must classify to an intent on THAT allowlist, or the
// chip is a one-tap refusal for a client. Check the allowlist before adding
// or rewording a chip; the SME web app's clerk-ask page carries the same
// vetted set — keep the two in step.
export const SUGGESTED_QUESTIONS: readonly string[] = [
  "What's overdue?",
  "What did we submit this month?",
  "What invoices haven't gone out?",
  // data.aged_receivables (client-safe) — not "who owes us?", which lands in
  // data.outstanding_receivables and refuses for client askers.
  "What's been outstanding longest?",
];

/**
 * The answer held on screen after an ask settles — the console Ask page's
 * tested semantic, mirrored here and in the SME web app: a success REPLACES
 * the held answer with whatever it carried (a refusal IS the newest answer,
 * and a success WITHOUT an answer payload clears a stale one instead of
 * leaving it on screen), while an error keeps the previous answer — still
 * the newest truth the asker was given.
 */
export function heldAnswer(
  previous: ClerkAnswer | null,
  outcome:
    | { type: "success"; answer: ClerkAnswer | null | undefined }
    | { type: "error" },
): ClerkAnswer | null {
  return outcome.type === "success" ? (outcome.answer ?? null) : previous;
}

/**
 * The trimmed question when it fits the contract bounds, else null. The
 * screen submits exactly what this returns, so the button's enablement and
 * the request body can never disagree about validity.
 */
export function askableQuestion(raw: string): string | null {
  const q = raw.trim();
  if (q.length < QUESTION_MIN || q.length > QUESTION_MAX) return null;
  return q;
}

/**
 * Scope suffix for a data-grounded answer's "from your records" note: the
 * resolved display labels the server pinned the lookup to (a month label, a
 * client name — never ids), joined into one clause. Empty string when the
 * lookup ran unscoped, so callers can skip the parenthetical. Mirrors the
 * SME web app's dataAnswerScope.
 */
export function dataAnswerScope(
  dataParams: Record<string, string> | undefined,
): string {
  return Object.values(dataParams ?? {})
    .filter((v) => v.trim().length > 0)
    .join(" · ");
}

/**
 * The one-line source note under an answered question. A data-grounded
 * answer says where the numbers came from — "From your records (June 2026 ·
 * Acme Ltd) · <citation>" — while a register answer cites the approved claim
 * that backs the words. Tolerates missing optional pieces so the line never
 * renders "undefined".
 */
export function answerSourceNote(
  answer: Pick<
    ClerkAnswer,
    "dataIntent" | "dataParams" | "citation" | "claimKey" | "claimVersion"
  >,
): string {
  if (answer.dataIntent) {
    const scope = dataAnswerScope(answer.dataParams);
    const base = scope ? `From your records (${scope})` : "From your records";
    return answer.citation ? `${base} · ${answer.citation}` : base;
  }
  const parts: string[] = [];
  if (answer.citation) parts.push(`Source: ${answer.citation}`);
  if (answer.claimKey) {
    const version =
      typeof answer.claimVersion === "number" ? ` v${answer.claimVersion}` : "";
    parts.push(`approved claim ${answer.claimKey}${version}`);
  }
  return parts.join(" · ");
}
