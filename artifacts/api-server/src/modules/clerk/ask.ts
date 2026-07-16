import { eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  type ClerkCase,
  type ClaimRecord,
  type ClerkAnswer,
  type ProtectedFact,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { lagosDateString } from "../../lib/lagos-time";
import { logger } from "../../lib/logger";
import { assertClerkEnabled, type ClerkGateway } from "./gateway";
import { inClerkScope } from "./scope";
import { getActiveClaims } from "./claims";
import { getDataIntent, DATA_INTENTS } from "./data-intents";
import {
  INTENT_PROMPT_VERSION,
  INTENT_SYSTEM,
  fenceUntrusted,
  intentJsonSchema,
  intentValidator,
  type IntentOutput,
} from "./prompts";

// Ask Clerk (Task #40, C1 + idea #6). The model's ONLY job is picking which
// key a question is about — from a closed enum of active claim keys plus, for
// firm-scoped askers, the data-intent catalogue (data-intents.ts). The answer
// itself is assembled deterministically: claim answers insert protected facts
// verbatim from the claim row; data answers run a fixed, fully parameterized
// query under the asker's own firm scope. Anything outside the two catalogues
// produces a neutral refusal and an escalated case (fail closed).

export function formatFact(fact: ProtectedFact): string {
  if (!fact.unit) return fact.value;
  if (fact.unit === "%") return `${fact.value}%`;
  return `${fact.value} ${fact.unit}`;
}

// Replace {factKey} placeholders in the proposition with verbatim protected
// fact values. Unknown placeholders are left intact (visible, not invented).
export function renderProposition(claim: ClaimRecord): string {
  const byKey = new Map(claim.protectedFacts.map((f) => [f.key, f]));
  return claim.proposition.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    const fact = byKey.get(key);
    return fact ? formatFact(fact) : match;
  });
}

const REFUSAL_PREFIX =
  "I can only answer from the approved claims register. ";

export async function askClerk(
  question: string,
  actorId: string,
  gateway: ClerkGateway,
  // Firm attribution for firm-facing Ask Clerk (expansion A): scopes the
  // question case to the asker's firm and charges the call to its budget.
  ctx: { firmId?: string | null } = {},
): Promise<ClerkCase> {
  await assertClerkEnabled();

  // The route runs outside the request transaction (app.ts NO_CONTEXT_ROUTES)
  // so the classification model call never pins a pooled connection; each DB
  // stage commits in its own short firm scope (see scope.ts). Committing the
  // question case before inferring also lets the gateway's raw-pool ledger
  // row reference it.
  const [created] = await inClerkScope(ctx.firmId, () =>
    getDb()
      .insert(clerkCasesTable)
      .values({
        kind: "question",
        status: "pending",
        question,
        firmId: ctx.firmId ?? null,
        createdBy: actorId,
      })
      .returning(),
  );

  const finish = async (
    answer: ClerkAnswer,
    status: "approved" | "escalated",
  ): Promise<ClerkCase> => {
    const [row] = await inClerkScope(ctx.firmId, () =>
      getDb()
        .update(clerkCasesTable)
        .set({ status, answer })
        .where(eq(clerkCasesTable.id, created.id))
        .returning(),
    );
    await appendAudit({
      actorId,
      action: "clerk.ask",
      entityType: "clerk_case",
      entityId: created.id,
      after: {
        answered: answer.answered,
        claimKey: answer.claimKey ?? null,
        dataIntent: answer.dataIntent ?? null,
        refusalReason: answer.refusalReason ?? null,
      },
    });
    return row;
  };

  const refuse = (reason: string): Promise<ClerkCase> =>
    finish(
      { answered: false, refusalReason: REFUSAL_PREFIX + reason },
      "escalated",
    );

  const active = await getActiveClaims();
  // Data intents are firm-record lookups, so they are only offered to a
  // firm-scoped asker; an operator without a tenant keeps register-only Ask.
  const dataIntents = ctx.firmId ? DATA_INTENTS : [];
  if (active.length === 0 && dataIntents.length === 0) {
    return refuse(
      "The register has no active claims yet, so this question has been escalated to an operator.",
    );
  }

  const keys = [
    ...new Set([
      ...active.map((c) => c.claimKey),
      ...dataIntents.map((i) => i.key),
    ]),
  ];
  const registerIndex = active
    .map((c) => `- ${c.claimKey}: ${c.title}`)
    .join("\n");
  const user = [
    "Available claim keys (approved register):",
    registerIndex || "(none)",
    ...(dataIntents.length > 0
      ? [
          "",
          "Available data keys (live lookups over the asker's own firm records):",
          dataIntents.map((i) => `- ${i.key}: ${i.title}`).join("\n"),
        ]
      : []),
    "",
    fenceUntrusted("question", "QUESTION", question),
  ].join("\n");

  const result = await gateway.infer<IntentOutput>({
    purpose: "classify_intent",
    caseId: created.id,
    firmId: ctx.firmId ?? null,
    promptVersion: INTENT_PROMPT_VERSION,
    system: INTENT_SYSTEM,
    user,
    schemaName: "intent_classification",
    jsonSchema: intentJsonSchema(keys),
    validator: intentValidator(keys) as never,
    inputForHash: question,
  });

  if (!result.ok) {
    return refuse(
      "The question could not be classified reliably, so it has been escalated to an operator.",
    );
  }
  if (result.data.claimKey === "none") {
    return refuse(
      "This question is not covered by an approved claim, so it has been escalated to an operator.",
    );
  }

  // Data-intent branch (idea #6), taken only when data keys were actually
  // OFFERED (firm-scoped asker): for those askers the catalogue is checked
  // first, so the platform-defined meaning of a "data.*" key wins over an
  // identically named claim. A firm-less asker's enum never contained data
  // keys, so a "data.*" pick there can only be a register claim — it falls
  // through to the claims path and answers normally.
  const firmId = ctx.firmId;
  const dataIntent = firmId ? getDataIntent(result.data.claimKey) : undefined;
  if (dataIntent && firmId) {
    let outcome;
    try {
      // The lookup runs in the SAME firm-scoped RLS posture as the request
      // (and every query also filters firm_id explicitly) — the asker can
      // only ever see numbers computed from its own firm's rows.
      outcome = await inClerkScope(firmId, () => dataIntent.run(firmId));
    } catch (err) {
      logger.warn(
        { err, dataIntent: dataIntent.key },
        "ask clerk: data-intent lookup failed",
      );
      return refuse(
        "The firm-record lookup failed, so the question has been escalated to an operator.",
      );
    }
    return finish(
      {
        answered: true,
        dataIntent: dataIntent.key,
        proposition: outcome.text,
        facts: outcome.facts,
        citation: `Computed live from your firm's records on ${lagosDateString()} (Lagos)`,
      },
      "approved",
    );
  }

  // Fail-closed re-verification: the app, not the model, decides which claim
  // answers. Exactly one active, in-date claim must match the key.
  const matching = active.filter((c) => c.claimKey === result.data.claimKey);
  if (matching.length !== 1) {
    return refuse(
      "The register does not have exactly one active claim for this topic, so it has been escalated to an operator.",
    );
  }
  const claim = matching[0];

  // Deterministic applicability check: if the claim is scoped to a category
  // and the question is clearly about a different one, refuse.
  const scope = claim.applicability.category;
  if (scope && result.data.category !== "unknown" && result.data.category !== scope) {
    return refuse(
      `The matching claim applies to ${scope.toUpperCase()} transactions, but the question appears to be about ${result.data.category.toUpperCase()}. It has been escalated to an operator.`,
    );
  }

  return finish(
    {
      answered: true,
      claimId: claim.id,
      claimKey: claim.claimKey,
      claimVersion: claim.version,
      proposition: renderProposition(claim),
      facts: claim.protectedFacts,
      citation: claim.citation,
    },
    "approved",
  );
}
