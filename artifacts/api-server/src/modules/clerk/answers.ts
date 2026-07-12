import { and, eq } from "drizzle-orm";
import { getDb, claimRecordsTable, errorCatalogueTable } from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  getAnswerableClaim,
  renderClaim,
  type RenderedClaim,
} from "./claims";
import { checkKillSwitches, recordRefusal, runInference } from "./gateway";

// Register-only answers (CLK-AI-03/04) and catalogue-grounded rejection
// explanations (CLK-KB-05). The decision sequence is §8.1 of the supplement:
// classify intent → retrieve active claims → resolve deterministically →
// render protected facts in application code → otherwise refuse and escalate.
// Uncertainty is a product state, not confident prose.

const INTENT_MODEL = "deterministic-intent-v1";
const INTENT_PROMPT_VERSION = "keyword-match-v1";

export interface ClerkAnswerResult {
  outcome: "answered" | "refused";
  answer: string | null;
  claimKey: string | null;
  claimVersion: number | null;
  citation: string | null;
  protectedFacts: RenderedClaim["protectedFacts"];
  refusalReason: string | null;
  escalated: boolean;
}

function refusal(reason: string): ClerkAnswerResult {
  return {
    outcome: "refused",
    answer: null,
    claimKey: null,
    claimVersion: null,
    citation: null,
    protectedFacts: [],
    refusalReason: reason,
    escalated: true,
  };
}

// The credit-language embargo (M&S rules; AI brief §3.4): Clerk never
// discusses financing before the R4 gate lifts. The scripted deflection is
// verbatim product copy, and the interest is logged.
const EMBARGO_PATTERN =
  /\b(loan|loans|credit|financing|finance|lend|lending|borrow|borrowing|overdraft|early\s+payment|interest\s+rate|working\s+capital)\b/i;

const EMBARGO_DEFLECTION =
  "I can't discuss financing or credit. MeridianIQ helps you keep compliant " +
  "records; if financing products ever become available, your firm will hear " +
  "about it through official channels. Is there a compliance question I can " +
  "help with?";

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, " ")
      .split(/[\s.]+/)
      .filter((t) => t.length >= 3),
  );
}

// Deterministic intent resolution: score every active claim by token overlap
// between the question and the claim's key + proposition. This is v1's
// stand-in for a classifier — being pure code, it can be reasoned about and
// its failure mode is refusal, never invention. More than one incompatible
// result is not an answer (§8.1 step 3).
async function resolveClaimIntent(
  question: string,
): Promise<
  | { kind: "match"; claimKey: string }
  | { kind: "ambiguous"; top: string[] }
  | { kind: "none" }
> {
  const active = await getDb()
    .select({
      claimKey: claimRecordsTable.claimKey,
      proposition: claimRecordsTable.proposition,
    })
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.status, "active"));
  if (active.length === 0) return { kind: "none" };

  const questionTokens = tokenize(question);
  const scored = active
    .map((c) => {
      const claimTokens = tokenize(
        `${c.claimKey.replace(/[._]/g, " ")} ${c.proposition}`,
      );
      let overlap = 0;
      for (const t of questionTokens) if (claimTokens.has(t)) overlap += 1;
      return { claimKey: c.claimKey, score: overlap };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    return {
      kind: "ambiguous",
      top: [scored[0].claimKey, scored[1].claimKey],
    };
  }
  return { kind: "match", claimKey: scored[0].claimKey };
}

export async function askClerk(input: {
  question: string;
  firmId: string | null;
  actor: { userId: string; role: string };
}): Promise<ClerkAnswerResult> {
  const gate = await checkKillSwitches("answers");
  if (!gate.allowed) {
    return refusal(gate.reason);
  }

  // Embargoed topics refuse with the scripted deflection and log the interest
  // (the audit row IS the log of demand for the future product).
  if (EMBARGO_PATTERN.test(input.question)) {
    await recordRefusal({
      firmId: input.firmId,
      purpose: "answer",
      model: INTENT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      input: input.question,
      reason: "credit_embargo",
    });
    await appendAudit({
      actorId: input.actor.userId,
      actorRole: input.actor.role,
      firmId: input.firmId,
      action: "clerk.refused",
      entityType: "clerk_answer",
      entityId: "credit_embargo",
    });
    return { ...refusal(EMBARGO_DEFLECTION), escalated: false };
  }

  const intent = await resolveClaimIntent(input.question);
  if (intent.kind !== "match") {
    const reason =
      intent.kind === "ambiguous"
        ? "More than one approved answer could apply to this question. A human operator will follow up rather than have Clerk guess."
        : "This question isn't covered by our approved sources. A human operator will follow up rather than have Clerk guess.";
    await recordRefusal({
      firmId: input.firmId,
      purpose: "answer",
      model: INTENT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      input: input.question,
      reason: intent.kind === "ambiguous" ? "ambiguous" : "unsupported",
    });
    await appendAudit({
      actorId: input.actor.userId,
      actorRole: input.actor.role,
      firmId: input.firmId,
      action: "clerk.refused",
      entityType: "clerk_answer",
      entityId: intent.kind,
    });
    return refusal(reason);
  }

  // Freshness and effectiveness are re-checked at answer time (CLK-KB-07):
  // an expired, suspended or review-overdue record cannot answer.
  const lookup = await getAnswerableClaim(intent.claimKey);
  if (!lookup.ok) {
    const reason =
      lookup.reason === "overdue_review"
        ? "The approved source for this answer is overdue for review, so Clerk won't quote it. A human operator will follow up."
        : "The approved source for this answer isn't currently in effect. A human operator will follow up.";
    await recordRefusal({
      firmId: input.firmId,
      purpose: "answer",
      model: INTENT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      input: input.question,
      reason: lookup.reason,
    });
    return refusal(reason);
  }

  // Deterministic render — protected facts are inserted by application code
  // (CLK-AI-03); the "inference" run records provenance for the answer path.
  const rendered = renderClaim(lookup.claim);
  await runInference({
    firmId: input.firmId,
    purpose: "answer",
    model: INTENT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    input: input.question,
    run: () => ({
      output: {
        claimKey: rendered.claimKey,
        claimVersion: rendered.claimVersion,
      },
      confidence: null,
    }),
  });

  return {
    outcome: "answered",
    answer: rendered.answer,
    claimKey: rendered.claimKey,
    claimVersion: rendered.claimVersion,
    citation: rendered.citation,
    protectedFacts: rendered.protectedFacts,
    refusalReason: null,
    escalated: false,
  };
}

export interface ClerkExplanationResult {
  outcome: "explained" | "refused";
  code: string | null;
  cause: string | null;
  fix: string | null;
  retriable: boolean | null;
  catalogueSource: string | null;
  refusalReason: string | null;
}

// Rejection translation (CLK-KB-05): the living error catalogue is the ONLY
// source Clerk may explain a failure from. An unmapped code is a refusal —
// and the existing desk sweep separately opens an operator case so the
// mapping enters the catalogue within a working day (INT-02).
export async function explainRejection(input: {
  errorCode: string;
  firmId: string | null;
}): Promise<ClerkExplanationResult> {
  const gate = await checkKillSwitches("explanation");
  if (!gate.allowed) {
    return {
      outcome: "refused",
      code: null,
      cause: null,
      fix: null,
      retriable: null,
      catalogueSource: null,
      refusalReason: gate.reason,
    };
  }
  const [entry] = await getDb()
    .select()
    .from(errorCatalogueTable)
    .where(and(eq(errorCatalogueTable.code, input.errorCode)))
    .limit(1);
  if (!entry) {
    await recordRefusal({
      firmId: input.firmId,
      purpose: "explanation",
      model: "catalogue-lookup-v1",
      promptVersion: "v1",
      input: input.errorCode,
      reason: "unmapped_code",
    });
    return {
      outcome: "refused",
      code: null,
      cause: null,
      fix: null,
      retriable: null,
      catalogueSource: null,
      refusalReason:
        "This failure code isn't in the approved catalogue yet. It has been flagged for the Desk to map — a human will follow up with the fix.",
    };
  }
  await runInference({
    firmId: input.firmId,
    purpose: "explanation",
    model: "catalogue-lookup-v1",
    promptVersion: "v1",
    input: input.errorCode,
    run: () => ({
      output: { code: entry.code },
      confidence: null,
    }),
  });
  return {
    outcome: "explained",
    code: entry.code,
    cause: entry.cause,
    fix: entry.fix,
    retriable: entry.retriable,
    catalogueSource: entry.source,
    refusalReason: null,
  };
}
