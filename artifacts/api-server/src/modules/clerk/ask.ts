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
import {
  assertClerkEnabled,
  type ClerkGateway,
  type MemoryEmbedder,
} from "./gateway";
import { computeAskMemory } from "./ask-memory";
import { inClerkScope } from "./scope";
import { getActiveClaims } from "./claims";
import { lagosMonthOptions } from "./data-intents";
import {
  INTENT_PROMPT_VERSION,
  INTENT_SYSTEM,
  fenceUntrusted,
  planJsonSchema,
  planValidator,
  type PlanOutput,
} from "./prompts";
import type { ActionKind } from "./actions";
import {
  loadClientOptions,
  offeredActionIntents,
  offeredDataIntents,
} from "./ask-offer";
import { previousContextFor } from "./ask-followup";
import { runPlanSteps } from "./ask-steps";
import { resolveOutcomes, type AskAnswer } from "./ask-answer";

// Ask Clerk (Task #40, C1 + idea #6; Ask 2.0 plans, contract 0.56.0). The
// model's ONLY job is producing an ordered PLAN of 1-3 keys — each from the
// closed enum of active claim keys plus, for firm-scoped askers, the
// data-intent catalogue (data-intents/) — in ONE call. The answer itself is
// assembled deterministically: claim answers insert protected facts verbatim
// from the claim row; each data step runs a fixed, fully parameterized query
// under the asker's own firm scope with its OWN freshly resolved parameters.
// Anything outside the two catalogues (or an empty plan) produces a neutral
// refusal and an escalated case (fail closed).
//
// R126: the flow is split behind this façade — ask-offer.ts (the catalogues
// and option lists THIS asker is offered), ask-followup.ts (multi-turn
// context), ask-steps.ts (step execution) and ask-answer.ts (the
// contract-mirroring AskAnswer shape and the deterministic answer fold).
// The single bare gateway.infer call, the question case, the refusal prefix
// and the clerk.ask audit stay here.

// The Ask 2.0 answer extension (contract 0.56.0) lives in ask-answer.ts and
// MUST mirror openapi.yaml; re-exported so consumers keep this import path.
export type {
  AskAnswer,
  AskAnswerPins,
  AskAnswerSection,
  AskSectionAction,
} from "./ask-answer";

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

const REFUSAL_PREFIX = "I can only answer from the approved claims register. ";

// The classifier's user prompt, assembled in ONE place. The intent eval
// lane (intent-eval.ts) calls this with a FIXED synthetic context, so the
// corpus measures the exact prompt shape production sends — a drift here is
// a drift there, never a silent divergence.
export interface IntentPromptContext {
  claims: { claimKey: string; title: string }[];
  dataIntents: readonly { key: string; title: string }[];
  // Do with Clerk (round 31): the act.* keys offered to THIS asker (empty =
  // read-only Ask, and the block below renders nothing — byte-stable with
  // the v6 prompt shape for askers without action keys).
  actionIntents: readonly { key: string; title: string }[];
  months: { key: string; label: string }[];
  clients: { key: string; name: string }[];
  clientsTruncated: boolean;
  previousContext?: string[];
  question: string;
}

export function buildIntentUser(ctx: IntentPromptContext): string {
  const registerIndex = ctx.claims
    .map((c) => `- ${c.claimKey}: ${c.title}`)
    .join("\n");
  return [
    "Available claim keys (approved register):",
    registerIndex || "(none)",
    ...(ctx.dataIntents.length > 0
      ? [
          "",
          "Available data keys (live lookups over the asker's own firm records):",
          ctx.dataIntents.map((i) => `- ${i.key}: ${i.title}`).join("\n"),
          ...(ctx.actionIntents.length > 0
            ? [
                "",
                "Action keys (each PROPOSES work on the asker's own records for explicit approval — nothing executes from an answer):",
                ctx.actionIntents
                  .map((a) => `- ${a.key}: ${a.title}`)
                  .join("\n"),
              ]
            : []),
          "",
          "Month keys (for data lookups that take a month):",
          ctx.months.map((m) => `- ${m.key}: ${m.label}`).join("\n"),
          ...(ctx.clients.length > 0
            ? [
                "",
                "Client keys (the asker's own clients, for data lookups):",
                // Client legal names are user-authored — they ride inside a
                // fence so a name can never smuggle instructions; the c1..cN
                // keys around them are app-built and trusted.
                fenceUntrusted(
                  "client name directory (match names to keys only)",
                  "CLIENT_NAMES",
                  ctx.clients.map((c) => `- ${c.key}: ${c.name}`).join("\n"),
                ),
                ...(ctx.clientsTruncated
                  ? [
                      // The one plan-era wording change in this builder: the
                      // v6 refusal is the EMPTY steps array, not claimKey
                      // "none". Catalogue rendering above stays byte-stable.
                      "This client list is INCOMPLETE. If the question names a client that is not listed, answer an EMPTY steps array — never answer a client-scoped question firm-wide.",
                    ]
                  : []),
              ]
            : []),
        ]
      : []),
    ...(ctx.previousContext ?? []),
    "",
    fenceUntrusted("question", "QUESTION", ctx.question),
  ].join("\n");
}

export async function askClerk(
  question: string,
  actorId: string,
  gateway: ClerkGateway,
  // Firm attribution for firm-facing Ask Clerk (expansion A): scopes the
  // question case to the asker's firm and charges the call to its budget.
  // previousCaseId (round-12 idea #3, multi-turn): the asker's prior
  // question case in this thread — loaded under the SAME firm scope, and
  // only its platform-recorded intent + resolved parameter KEYS reach the
  // classifier as context, so "and for June?" can follow on. Conversation
  // state lives entirely in data the app already stores.
  // clientScoped/clientPartyId (SEC-03): the client_user posture, resolved
  // from the PRINCIPAL by the route. A client asker is offered only the
  // client-safe data intents, its client option list is exactly its own
  // party, every lookup is FORCED to that party regardless of what the
  // model picked, and multi-turn context only threads its OWN cases —
  // firm-keyed RLS is not a sibling wall.
  // actionKinds (round 31, Do with Clerk): the action-catalogue kinds THIS
  // principal could approve (the route computes them from the same
  // capability gates the execute route enforces). Only these are offered as
  // act.* plan keys; empty/absent means Ask stays read-only for this asker.
  ctx: {
    firmId?: string | null;
    previousCaseId?: string | null;
    clientScoped?: boolean;
    clientPartyId?: string | null;
    actionKinds?: ActionKind[];
    // Round 47 (test injection only): the memory note's embedder. Omitted
    // in production — ask-memory resolves the provider embedder lazily,
    // after the memory-rail gates pass.
    memoryEmbedder?: MemoryEmbedder | null;
  } = {},
): Promise<ClerkCase> {
  await assertClerkEnabled();

  // The route runs outside the request transaction (middleware/request-policy.ts NO_CONTEXT_ROUTES)
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
    answer: AskAnswer,
    status: "approved" | "escalated",
  ): Promise<ClerkCase> => {
    // Retrieval-augmented Ask (round 47): the memory note attaches ONLY to
    // an ANSWERED, firm-scoped case, after the answer is fully assembled —
    // best-effort app code with no model involvement (ask-memory.ts owns
    // the gates, the SEC-03 own-cases pin for client askers, and the
    // pointer-first shape). A refusal carries no note: an escalated case's
    // operator should not inherit a similarity guess.
    const withMemory: AskAnswer =
      status === "approved" && answer.answered && ctx.firmId
        ? await (async () => {
            const memory = await computeAskMemory({
              firmId: ctx.firmId!,
              question,
              actorId,
              clientScoped: ctx.clientScoped === true,
              clientPartyId: ctx.clientPartyId,
              excludeCaseId: created.id,
              embedder: ctx.memoryEmbedder,
            });
            return memory ? { ...answer, memory } : answer;
          })()
        : answer;
    const [row] = await inClerkScope(ctx.firmId, () =>
      getDb()
        .update(clerkCasesTable)
        // The stored jsonb type has not grown the 0.56.0 plan/pins/sections
        // fields yet — AskAnswer above is the contract-mirroring superset.
        .set({ status, answer: withMemory as ClerkAnswer })
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
        // Ask 2.0: the executed plan's intent keys — pointer-only platform
        // strings (catalogue keys, never user or model text).
        plan: answer.plan ? answer.plan.map((p) => p.key) : null,
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
  // A client_user (SEC-03) gets only the client-safe subset — every lookup
  // it can name is pinned to its own party in the step runner — and, fail
  // closed, no data intents at all if the principal somehow carries no client
  // party (ask-offer.ts).
  const clientScoped = ctx.clientScoped === true;
  const dataIntents = offeredDataIntents({
    firmId: ctx.firmId,
    clientScoped,
    clientPartyId: ctx.clientPartyId,
  });
  if (active.length === 0 && dataIntents.length === 0) {
    return refuse(
      "The register has no active claims yet, so this question has been escalated to an operator.",
    );
  }

  // Do with Clerk (round 31): act.* keys are offered only when the asker
  // already gets data keys, the actions rollout flag is on and the route
  // said this principal could approve that kind (ask-offer.ts — the flag
  // read happens here, AFTER the no-claims refusal, exactly as before).
  const offeredActions = await offeredActionIntents(
    { firmId: ctx.firmId, actionKinds: ctx.actionKinds },
    dataIntents,
  );

  const keys = [
    ...new Set([
      ...active.map((c) => c.claimKey),
      ...dataIntents.map((i) => i.key),
      ...offeredActions.map((a) => a.key),
    ]),
  ];

  // Closed parameter options (idea #4), offered only alongside data intents:
  // the last twelve Lagos months, and the firm's own client parties under
  // OPAQUE keys the app maps back — the model can only ever pick an entry
  // the app itself built. A client asker's list is EXACTLY ONE entry: its
  // own party (SEC-03) — the model can only ever pick the caller itself.
  const months = dataIntents.length > 0 ? lagosMonthOptions() : [];
  const monthByKey = new Map(months.map((m) => [m.key, m]));
  const { options: clientOptions, truncated: clientsTruncated } =
    await loadClientOptions(
      { firmId: ctx.firmId, clientScoped, clientPartyId: ctx.clientPartyId },
      dataIntents,
    );
  const clientByKey = new Map(clientOptions.map((c) => [c.key, c]));

  // Multi-turn context (round-12 idea #3; pins-by-id since 0.56.0): the
  // previous question case's PLATFORM-RECORDED intent and resolved scope,
  // translated back into keys from THIS request's closed lists
  // (ask-followup.ts). Only data-intent answers carry context — claim
  // answers need none.
  const previousContext = await previousContextFor({
    previousCaseId: ctx.previousCaseId,
    firmId: ctx.firmId,
    clientScoped,
    actorId,
    dataIntents,
    keys,
    months,
    clientOptions,
  });

  const user = buildIntentUser({
    claims: active,
    dataIntents,
    actionIntents: offeredActions,
    months,
    clients: clientOptions,
    clientsTruncated,
    previousContext,
    question,
  });

  const monthKeys = months.map((m) => m.key);
  const clientKeys = clientOptions.map((c) => c.key);
  // ONE model call per ask, plan or no plan (the data-intents.test.ts pin):
  // the planner returns the whole ordered plan in a single inference, and
  // everything after this line is deterministic app code. Bare gateway.infer
  // is correct here (rate-limit-lockstep allowlist): a typed failure refuses
  // and escalates — there is no template to fall back to.
  const result = await gateway.infer<PlanOutput>({
    purpose: "classify_intent",
    caseId: created.id,
    firmId: ctx.firmId ?? null,
    promptVersion: INTENT_PROMPT_VERSION,
    system: INTENT_SYSTEM,
    user,
    schemaName: "intent_classification",
    jsonSchema: planJsonSchema(keys, monthKeys, clientKeys),
    validator: planValidator(keys, monthKeys, clientKeys) as never,
    inputForHash: question,
  });

  if (!result.ok) {
    return refuse(
      "The question could not be classified reliably, so it has been escalated to an operator.",
    );
  }
  // Duplicate steps dedup, app-side: the prompt forbids repeating a key with
  // identical pins, but the app enforces it — identity is the step's
  // EFFECTIVE scope, so for a client asker (whose every lookup is forced to
  // its own party below) the client pick is irrelevant to identity.
  const seenSteps = new Set<string>();
  const steps = result.data.steps.filter((s) => {
    const sig = `${s.key}\0${s.month}\0${clientScoped ? "own" : s.client}`;
    if (seenSteps.has(sig)) return false;
    seenSteps.add(sig);
    return true;
  });
  // An EMPTY plan is the model's refusal (the v6 schema has no "none" key —
  // emptiness is the none), same neutral escalation as ever.
  if (steps.length === 0) {
    return refuse(
      "This question is not covered by an approved claim, so it has been escalated to an operator.",
    );
  }

  // Step resolution runs against the intents THIS asker was OFFERED
  // (firm-scoped asker only), so the platform-defined meaning of a "data.*"
  // key wins over an identically named claim — and a client asker can never
  // run an intent outside its client-safe subset (SEC-03), even via a
  // colliding claim key. A firm-less asker's enum never contained data keys,
  // so a "data.*" pick there can only be a register claim — it falls through
  // to the claims path and answers normally.
  const firmId = ctx.firmId;
  const planned = steps.map((step) => ({
    step,
    dataIntent: firmId
      ? dataIntents.find((i) => i.key === step.key)
      : undefined,
    // Do with Clerk (round 31): an act.* pick resolves against the intents
    // THIS asker was offered — same fail-closed re-verification as data
    // keys; an asker never offered the key cannot reach the branch.
    actionIntent: firmId
      ? offeredActions.find((a) => a.key === step.key)
      : undefined,
  }));

  // A register claim answers ALONE: its category-applicability logic (below)
  // is single-answer logic, and a claim proposition pasted between data
  // sections would blur whose citation covers what. Any plan longer than one
  // step containing a claim key refuses whole (fail closed).
  if (
    planned.length > 1 &&
    planned.some((p) => !p.dataIntent && !p.actionIntent)
  ) {
    return refuse(
      "A register claim answers one question at a time and cannot be combined with other lookups, so this question has been escalated to an operator.",
    );
  }

  // ---- Data + action steps -------------------------------------------------
  // Each step runs with a FRESH DataIntentParams under the asker's firm
  // scope (ask-steps.ts); the outcomes fold deterministically into ONE
  // answer or ONE bare refusal reason (ask-answer.ts), which refuses here
  // with the same prefix and escalation as every other refusal.
  if (firmId && planned.every((p) => p.dataIntent || p.actionIntent)) {
    const outcomes = await runPlanSteps(
      {
        firmId,
        question,
        clientScoped,
        clientPartyId: ctx.clientPartyId,
        monthByKey,
        clientByKey,
        clientOptions,
      },
      planned,
    );
    const r = resolveOutcomes(outcomes);
    return "refuse" in r ? refuse(r.refuse) : finish(r.answer, "approved");
  }

  // ---- Register claim (single step) ----------------------------------------
  const claimStep = steps[0];
  // Fail-closed re-verification: the app, not the model, decides which claim
  // answers. Exactly one active, in-date claim must match the key.
  const matching = active.filter((c) => c.claimKey === claimStep.key);
  if (matching.length !== 1) {
    return refuse(
      "The register does not have exactly one active claim for this topic, so it has been escalated to an operator.",
    );
  }
  const claim = matching[0];

  // Deterministic applicability check: if the claim is scoped to a category
  // and the question is clearly about a different one, refuse.
  const scope = claim.applicability.category;
  if (
    scope &&
    result.data.category !== "unknown" &&
    result.data.category !== scope
  ) {
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
