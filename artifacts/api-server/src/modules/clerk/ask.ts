import { and, eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  engagementsTable,
  partiesTable,
  type ClerkCase,
  type ClaimRecord,
  type ClerkAnswer,
  type ClerkAnswerLink,
  type ProtectedFact,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { lagosDateString } from "../../lib/lagos-time";
import { logger } from "../../lib/logger";
import { assertClerkEnabled, type ClerkGateway } from "./gateway";
import { inClerkScope } from "./scope";
import { getActiveClaims } from "./claims";
import {
  lagosMonthOptions,
  extractInvoiceNumbers,
  stripCurrentMonth,
  CLIENT_SAFE_DATA_INTENTS,
  DATA_INTENTS,
  type DataIntent,
  type DataIntentParams,
  type DataIntentResult,
} from "./data-intents";
import {
  INTENT_PROMPT_VERSION,
  INTENT_SYSTEM,
  fenceUntrusted,
  planJsonSchema,
  planValidator,
  type PlanOutput,
  type PlanStep,
} from "./prompts";
import {
  ACTION_INTENTS,
  ACTIONS_FLAG_KEY,
  proposalForKind,
  type ActionIntent,
  type ActionKind,
  type ActionProposal,
} from "./actions";
import { isFeatureEnabled } from "../flags/flags";
import { plural } from "./text";

// Ask Clerk (Task #40, C1 + idea #6; Ask 2.0 plans, contract 0.56.0). The
// model's ONLY job is producing an ordered PLAN of 1-3 keys — each from the
// closed enum of active claim keys plus, for firm-scoped askers, the
// data-intent catalogue (data-intents/) — in ONE call. The answer itself is
// assembled deterministically: claim answers insert protected facts verbatim
// from the claim row; each data step runs a fixed, fully parameterized query
// under the asker's own firm scope with its OWN freshly resolved parameters.
// Anything outside the two catalogues (or an empty plan) produces a neutral
// refusal and an escalated case (fail closed).

// ---------------------------------------------------------------------------
// Ask 2.0 answer extension (contract 0.56.0). ClerkAnswer grew optional
// plan/pins/sections in the API contract; the @workspace/db jsonb type still
// carries the lean pre-0.56 shape, so the extension lives here and MUST
// mirror components/schemas ClerkAnswer.plan / ClerkAnswer.pins /
// AskAnswerSection in lib/api-spec/openapi.yaml — the stored answer IS the
// API answer (the route returns the whole case row).
// ---------------------------------------------------------------------------

// The scope a data answer resolved to, BY ID (+ display labels). A follow-up
// (previousCaseId) re-pins from these ids after validating them against the
// live option lists — never from display labels, which two clients may share.
export interface AskAnswerPins {
  monthStart?: string;
  monthLabel?: string;
  clientPartyId?: string;
  clientName?: string;
}

// One part of a multi-part answer: the executed intent's platform title, its
// deterministic text/facts/links, and the per-step display params.
export interface AskAnswerSection {
  title: string;
  text: string;
  dataIntent?: string;
  dataParams?: Record<string, string>;
  facts: ProtectedFact[];
  links?: ClerkAnswerLink[];
  // Do with Clerk (round 31, contract 0.60.0): present when this section is
  // an ACTION PROPOSAL assembled from an act.* plan step — everything the
  // approval surface needs to drive the EXISTING execute route (kind, the
  // resolved client, the capped target ids). A proposal, never an
  // execution: the execute route re-asserts capability/flag/consent and
  // re-validates every target at approval time.
  action?: AskSectionAction;
}

export interface AskSectionAction {
  kind: ActionKind;
  clientPartyId: string;
  clientName: string;
  why: string;
  targetCount: number;
  truncated: boolean;
  invoiceIds: string[];
}

export type AskAnswer = ClerkAnswer & {
  // The ordered intents the planner executed (app-resolved titles), present
  // only on multi-part answers; single-step and register answers keep the
  // exact pre-0.56 flat shape (plus pins on data answers).
  plan?: { key: string; title: string }[];
  pins?: AskAnswerPins;
  sections?: AskAnswerSection[];
};

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
  } = {},
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
    answer: AskAnswer,
    status: "approved" | "escalated",
  ): Promise<ClerkCase> => {
    const [row] = await inClerkScope(ctx.firmId, () =>
      getDb()
        .update(clerkCasesTable)
        // The stored jsonb type has not grown the 0.56.0 plan/pins/sections
        // fields yet — AskAnswer above is the contract-mirroring superset.
        .set({ status, answer: answer as ClerkAnswer })
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
  // it can name is pinned to its own party below — and, fail closed, no data
  // intents at all if the principal somehow carries no client party.
  const clientScoped = ctx.clientScoped === true;
  const dataIntents = !ctx.firmId
    ? []
    : clientScoped
      ? ctx.clientPartyId
        ? CLIENT_SAFE_DATA_INTENTS
        : []
      : DATA_INTENTS;
  if (active.length === 0 && dataIntents.length === 0) {
    return refuse(
      "The register has no active claims yet, so this question has been escalated to an operator.",
    );
  }

  // Do with Clerk (round 31): act.* keys are offered only when (a) the asker
  // already gets data keys (act keys share the data lookups' month/client
  // option machinery, and every asker who may approve actions is
  // firm-scoped), (b) the actions rollout flag is on (dark = the keys
  // simply don't exist, same fail-closed posture as listActionProposals),
  // and (c) the route said this principal could approve that kind. A client
  // asker keeps its own-party pinning below, exactly like data lookups.
  const offeredActions: readonly ActionIntent[] =
    ctx.firmId &&
    dataIntents.length > 0 &&
    (ctx.actionKinds?.length ?? 0) > 0 &&
    (await isFeatureEnabled(ACTIONS_FLAG_KEY, ctx.firmId))
      ? ACTION_INTENTS.filter((a) => ctx.actionKinds!.includes(a.kind))
      : [];

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
  const CLIENT_OPTION_CAP = 40;
  const clients =
    dataIntents.length > 0 && ctx.firmId
      ? await inClerkScope(ctx.firmId, () =>
          getDb()
            .selectDistinct({
              id: partiesTable.id,
              name: partiesTable.legalName,
            })
            .from(partiesTable)
            .innerJoin(
              engagementsTable,
              eq(engagementsTable.clientPartyId, partiesTable.id),
            )
            .where(
              clientScoped
                ? and(
                    eq(engagementsTable.firmId, ctx.firmId!),
                    eq(partiesTable.id, ctx.clientPartyId!),
                  )
                : eq(engagementsTable.firmId, ctx.firmId!),
            )
            .orderBy(partiesTable.legalName)
            // One past the cap so truncation is DETECTED, never silent.
            .limit(CLIENT_OPTION_CAP + 1),
        )
      : [];
  const clientsTruncated = clients.length > CLIENT_OPTION_CAP;
  const clientOptions = clients
    .slice(0, CLIENT_OPTION_CAP)
    .map((c, i) => ({ key: `c${i + 1}`, ...c }));
  const clientByKey = new Map(clientOptions.map((c) => [c.key, c]));

  // Multi-turn context (round-12 idea #3; pins-by-id since 0.56.0): the
  // previous question case's PLATFORM-RECORDED intent and resolved scope,
  // translated back into keys from THIS request's closed lists. Loaded under
  // the same firm scope with an explicit firm filter, so a foreign or
  // fabricated id yields no context; a previous scope no longer in the
  // offered lists contributes nothing (never a raw id or name). Only
  // data-intent answers carry context — claim answers need none.
  let previousContext: string[] = [];
  if (ctx.previousCaseId && ctx.firmId && dataIntents.length > 0) {
    const [prev] = await inClerkScope(ctx.firmId, () =>
      getDb()
        .select({
          answer: clerkCasesTable.answer,
          firmId: clerkCasesTable.firmId,
          kind: clerkCasesTable.kind,
        })
        .from(clerkCasesTable)
        .where(
          and(
            eq(clerkCasesTable.id, ctx.previousCaseId!),
            eq(clerkCasesTable.firmId, ctx.firmId!),
            eq(clerkCasesTable.kind, "question"),
            // SEC-03: firm-keyed RLS shares the firm across sibling clients,
            // so a client asker's thread must ALSO be its own — a sibling's
            // case id contributes no context, exactly like a cross-firm id.
            ...(clientScoped
              ? [eq(clerkCasesTable.createdBy, actorId)]
              : []),
          ),
        )
        .limit(1),
    );
    const prevAnswer = prev?.answer as AskAnswer | null | undefined;
    // The lookup to thread: the flat single-intent key, or — for a
    // multi-part answer — the last executed DATA step, the same step whose
    // scope the stored pins carry (round 31: a plan may end in an act.*
    // step, but an action proposal is never follow-up context — a trusted
    // context line naming an act key would instruct the model to re-propose
    // work the new question never asked for, the exact planted-step class
    // the v7 rules forbid; an act-only previous answer contributes nothing).
    const prevPlanDataKey = prevAnswer?.plan
      ? [...prevAnswer.plan]
          .reverse()
          .find((p) => dataIntents.some((i) => i.key === p.key))?.key
      : undefined;
    const prevIntent = prevAnswer?.dataIntent ?? prevPlanDataKey;
    if (prevIntent && keys.includes(prevIntent)) {
      let prevMonthKey: string | null = null;
      let prevClientKey: string | null = null;
      const pins = prevAnswer?.pins;
      if (pins) {
        // ID-based recovery (the 0.56.0 fix): the stored pins carry the
        // resolved monthStart and clientPartyId, validated against THIS
        // request's live option lists — lagosMonthOptions has moved on for a
        // year-old thread, and clientOptions is already SEC-03-narrowed for
        // a client asker, so a stale or out-of-scope pin is DROPPED silently
        // rather than trusted. Ids, not labels: two clients sharing a legal
        // name resolve to the exact party the previous answer used, where
        // label matching resolved whichever sorted first.
        prevMonthKey = pins.monthStart
          ? (months.find((m) => m.monthStart === pins.monthStart)?.key ??
            null)
          : null;
        prevClientKey = pins.clientPartyId
          ? (clientOptions.find((c) => c.id === pins.clientPartyId)?.key ??
            null)
          : null;
      } else {
        // Legacy label matching, kept ONLY for pre-0.56 cases that stored no
        // pins. The stored dataParams carry the resolved display LABELS
        // (month label, client legal name) — map them back to THIS request's
        // option keys; a label no longer in the offered lists contributes
        // nothing. Stored month labels are stripped of CURRENT_MONTH_SUFFIX
        // at answer time, so strip the offered labels the same way
        // (stripCurrentMonth — the shared spelling) before comparing —
        // otherwise a same-month follow-up silently loses its month scope.
        const prevParams = prevAnswer?.dataParams;
        prevMonthKey = prevParams?.month
          ? (months.find(
              (m) => stripCurrentMonth(m.label) === prevParams.month,
            )?.key ?? null)
          : null;
        prevClientKey = prevParams?.client
          ? (clientOptions.find((c) => c.name === prevParams.client)?.key ??
            null)
          : null;
      }
      previousContext = [
        "",
        `Previous question context (platform-recorded): the asker's previous question used data key ${prevIntent}${prevMonthKey ? `, month ${prevMonthKey}` : ""}${prevClientKey ? `, client ${prevClientKey}` : ""}.`,
        'If THIS question is a follow-up that changes only the month or client (e.g. "and for June?", "what about <another client>?"), answer with the SAME data key and the new parameter keys, carrying over any parameter the question does not change. If it is a new question, ignore this context.',
      ];
    }
  }

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
  if (firmId && planned.every((p) => p.dataIntent || p.actionIntent)) {
    // One step's execution, with a FRESH DataIntentParams per step (the
    // 0.56.0 fix: the old single shared params object would have leaked one
    // step's month/client into the next). Refusal reasons are returned, not
    // thrown: a single-step plan refuses the whole case with them verbatim
    // (the claim-gaps sentence catalogue), a multi-step plan turns them into
    // a could-not-answer section.
    type StepOutcome =
      | {
          ok: true;
          source: "data";
          dataIntent: DataIntent;
          params: DataIntentParams;
          result: DataIntentResult;
        }
      | { ok: false; source: "data"; dataIntent: DataIntent; reason: string }
      // Do with Clerk (round 31): an act.* step's outcome — the live-mined
      // proposal (null = nothing eligible right now, an honest answer, not
      // a refusal), plus the client it resolved to.
      | {
          ok: true;
          source: "action";
          act: ActionIntent;
          clientPartyId: string;
          clientName: string;
          proposal: ActionProposal | null;
        }
      | { ok: false; source: "action"; act: ActionIntent; reason: string };
    const runDataStep = async (
      dataIntent: DataIntent,
      step: PlanStep,
    ): Promise<StepOutcome> => {
      // Parameter resolution (idea #4): the model picked closed keys; the
      // app maps them back through ITS OWN option lists. An unknown key, or
      // a param the chosen lookup cannot honour, refuses — never a silently
      // unfiltered answer pretending to be a filtered one.
      const params: DataIntentParams = {};
      if (step.month !== "none") {
        const month = monthByKey.get(step.month);
        if (!month) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "The month in the question could not be resolved, so it has been escalated to an operator.",
          };
        }
        if (!dataIntent.accepts.month) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "That lookup always answers as of today and cannot be filtered to a month. Ask about rail submissions for month-by-month figures.",
          };
        }
        params.monthStart = month.monthStart;
        params.monthLabel = stripCurrentMonth(month.label);
      }
      if (step.client !== "none") {
        const client = clientByKey.get(step.client);
        if (!client) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "The client named in the question could not be resolved, so it has been escalated to an operator.",
          };
        }
        if (!dataIntent.accepts.client) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "That lookup covers the whole firm and cannot be filtered to one client.",
          };
        }
        params.clientPartyId = client.id;
        params.clientName = client.name;
      }
      // SEC-03: a client asker's scope comes from the PRINCIPAL, never from
      // the model. Whatever the planner picked (the only offered client
      // option is the caller's own party anyway), the lookup is FORCED to
      // that party before it runs — and ONLY onto an intent that honours a
      // client filter. Every client-offered intent does (the client-safe
      // test pin), so the refusal arm is defensive: an intent that would
      // IGNORE the forced pin must never run for a client asker (0.56.0 —
      // previously the pin was applied unconditionally AFTER the accepts
      // check, so such an intent would have run firm-wide).
      if (clientScoped && ctx.clientPartyId) {
        if (!dataIntent.accepts.client) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "That lookup covers the whole firm and cannot be filtered to one client.",
          };
        }
        params.clientPartyId = ctx.clientPartyId;
        const own = clientOptions.find((c) => c.id === ctx.clientPartyId);
        if (own) params.clientName = own.name;
      }
      // Invoice-pinned lookup (round 20): the number is APP-EXTRACTED from
      // the RAW question by a regex — the model only picked the key, and
      // nothing model-authored reaches the lookup. No number, or several,
      // refuses rather than guessing. Applied ONLY to a data.invoice_status
      // step, exactly as before plans.
      if (dataIntent.key === "data.invoice_status") {
        const numbers = extractInvoiceNumbers(question);
        if (numbers.length === 0) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "No invoice number could be read from the question. Name it exactly as it appears on the invoice (e.g. INV-2041) and ask again.",
          };
        }
        if (numbers.length > 1) {
          return {
            ok: false,
            source: "data",
            dataIntent,
            reason:
              "More than one invoice number appears in the question — ask about one invoice at a time.",
          };
        }
        params.invoiceNumber = numbers[0];
      }
      try {
        // The lookup runs in the SAME firm-scoped RLS posture as the request
        // (and every query also filters firm_id explicitly) — the asker can
        // only ever see numbers computed from its own firm's rows.
        const lookup = await inClerkScope(firmId, () =>
          dataIntent.run(firmId, params),
        );
        return { ok: true, source: "data", dataIntent, params, result: lookup };
      } catch (err) {
        logger.warn(
          { err, dataIntent: dataIntent.key },
          "ask clerk: data-intent lookup failed",
        );
        return {
          ok: false,
          source: "data",
          dataIntent,
          reason:
            "The firm-record lookup failed, so the question has been escalated to an operator.",
        };
      }
    };

    // Do with Clerk (round 31): resolve one act.* step to a live proposal.
    // The same closed-option client resolution as data steps (a client asker
    // is FORCED to its own party; a firm asker must name a listed client —
    // action batches are assembled per client, exactly like the existing
    // proposal surface). proposalForKind is read-only SQL mining; the model
    // never sees the result, and nothing here executes.
    const runActStep = async (
      act: ActionIntent,
      step: PlanStep,
    ): Promise<StepOutcome> => {
      if (step.month !== "none") {
        return {
          ok: false,
          source: "action",
          act,
          reason:
            "Action batches always cover today's eligible paper and cannot be filtered to a month.",
        };
      }
      let clientPartyId: string | null = null;
      let clientName = "";
      if (clientScoped && ctx.clientPartyId) {
        clientPartyId = ctx.clientPartyId;
        clientName =
          clientOptions.find((c) => c.id === ctx.clientPartyId)?.name ?? "";
      } else if (step.client !== "none") {
        const client = clientByKey.get(step.client);
        if (!client) {
          return {
            ok: false,
            source: "action",
            act,
            reason:
              "The client named in the question could not be resolved, so it has been escalated to an operator.",
          };
        }
        clientPartyId = client.id;
        clientName = client.name;
      }
      if (!clientPartyId) {
        return {
          ok: false,
          source: "action",
          act,
          reason:
            "Action batches are assembled per client — name the client this should apply to and ask again.",
        };
      }
      try {
        const proposal = await inClerkScope(firmId, () =>
          proposalForKind(act.kind, firmId, clientPartyId!),
        );
        return {
          ok: true,
          source: "action",
          act,
          clientPartyId,
          clientName,
          proposal,
        };
      } catch (err) {
        logger.warn(
          { err, actionIntent: act.key },
          "ask clerk: action-proposal assembly failed",
        );
        return {
          ok: false,
          source: "action",
          act,
          reason:
            "The action batch could not be assembled, so the question has been escalated to an operator.",
        };
      }
    };

    // Sequential, in plan order — later sections may narrate later months,
    // and the lookups share the caller's firm scope, not each other's params.
    const outcomes: StepOutcome[] = [];
    for (const p of planned) {
      outcomes.push(
        p.dataIntent
          ? await runDataStep(p.dataIntent, p.step)
          : await runActStep(p.actionIntent!, p.step),
      );
    }

    const displayParams = (
      params: DataIntentParams,
    ): Record<string, string> | undefined => {
      const d = {
        ...(params.monthLabel ? { month: params.monthLabel } : {}),
        ...(params.clientName ? { client: params.clientName } : {}),
      };
      return Object.keys(d).length > 0 ? d : undefined;
    };
    // The resolved scope BY ID (contract pins): what a follow-up re-pins
    // from, validated against the then-live option lists before use.
    const pinsOf = (params: DataIntentParams): AskAnswerPins => ({
      ...(params.monthStart
        ? { monthStart: params.monthStart, monthLabel: params.monthLabel }
        : {}),
      ...(params.clientPartyId
        ? {
            clientPartyId: params.clientPartyId,
            ...(params.clientName ? { clientName: params.clientName } : {}),
          }
        : {}),
    });
    const citation = `Computed live from your firm's records on ${lagosDateString()} (Lagos)`;

    // Single DATA step: EXACTLY the pre-plan flat answer shape (plus pins),
    // so every existing consumer, fixture and follow-up behaves identically
    // — including a single-step refusal (either source), which refuses the
    // whole case with the step's reason verbatim. A single answered ACT
    // step falls through to the sections shape: an action proposal is
    // inherently sectional (the approve payload lives on the section), and
    // no pre-round-31 consumer ever saw an act.* key, so there is no flat
    // shape to preserve.
    if (outcomes.length === 1 && !outcomes[0].ok) {
      return refuse(outcomes[0].reason);
    }
    if (outcomes.length === 1 && outcomes[0].source === "data") {
      const only = outcomes[0] as Extract<
        StepOutcome,
        { ok: true; source: "data" }
      >;
      const dataParams = displayParams(only.params);
      return finish(
        {
          answered: true,
          dataIntent: only.dataIntent.key,
          ...(dataParams ? { dataParams } : {}),
          proposition: only.result.text,
          facts: only.result.facts,
          // Open-the-invoice links (round 7), app-built from the lookup's
          // own sample rows. The lookup already ran firm/SEC-03-scoped (and
          // a client asker's party was FORCED above), so every id here is an
          // invoice the asker may already see.
          ...(only.result.links && only.result.links.length > 0
            ? { links: only.result.links }
            : {}),
          citation,
          pins: pinsOf(only.params),
        },
        "approved",
      );
    }

    // Every step refused: the whole case refuses with the FIRST reason —
    // one neutral escalation, exactly like a single-step refusal.
    const answeredSteps = outcomes.filter(
      (o): o is Extract<StepOutcome, { ok: true }> => o.ok,
    );
    if (answeredSteps.length === 0) {
      const first = outcomes[0] as Extract<StepOutcome, { ok: false }>;
      return refuse(first.reason);
    }

    // Multi-part answer: one section per executed step, in plan order. A
    // refused step keeps its slot with an honest could-not-answer text (its
    // escalation clause stripped — the case is APPROVED when any part
    // answered, so the sentence must not claim an escalation that did not
    // happen; the clause is this file's own pinned constant, see
    // claim-gaps.test.ts).
    const sections: AskAnswerSection[] = outcomes.map((o) => {
      if (!o.ok) {
        return {
          title: o.source === "data" ? o.dataIntent.title : o.act.title,
          text: `This part could not be answered. ${o.reason.replace(
            ", so it has been escalated to an operator.",
            ".",
          )}`,
          dataIntent: o.source === "data" ? o.dataIntent.key : o.act.key,
          facts: [],
        };
      }
      if (o.source === "action") {
        // An assembled proposal (or an honestly empty one). The section
        // text restates the approval invariant in words; the machine
        // payload under `action` is what the approve button drives —
        // through the EXISTING execute route, which re-checks everything.
        const clientParams = o.clientName
          ? { dataParams: { client: o.clientName } }
          : {};
        if (!o.proposal || o.proposal.targets.length === 0) {
          return {
            title: o.act.title,
            text: "Checked this client's paper just now — nothing is currently eligible for this action.",
            dataIntent: o.act.key,
            ...clientParams,
            facts: [],
          };
        }
        const p = o.proposal;
        return {
          title: o.act.title,
          text: `${p.why} This batch covers ${plural(p.targets.length, "invoice")}${
            p.truncated ? ` of the ${p.targetCount} that qualify` : ""
          }. Nothing runs until you approve it below — every target is re-checked at that moment, and the decision is recorded.`,
          dataIntent: o.act.key,
          ...clientParams,
          facts: [],
          action: {
            kind: p.kind,
            clientPartyId: o.clientPartyId,
            clientName: o.clientName,
            why: p.why,
            targetCount: p.targetCount,
            truncated: p.truncated,
            invoiceIds: p.targets.map((t) => t.invoiceId),
          },
        };
      }
      const dp = displayParams(o.params);
      return {
        title: o.dataIntent.title,
        text: o.result.text,
        dataIntent: o.dataIntent.key,
        ...(dp ? { dataParams: dp } : {}),
        facts: o.result.facts,
        ...(o.result.links && o.result.links.length > 0
          ? { links: o.result.links }
          : {}),
      };
    });
    // Follow-up pins come from the LAST answered DATA step — an action
    // proposal pins nothing (its scope lives on its own section, and "and
    // for June?" after an approval prompt is not a thing).
    const answeredData = answeredSteps.filter(
      (o): o is Extract<StepOutcome, { ok: true; source: "data" }> =>
        o.source === "data",
    );
    const lastAnswered = answeredData[answeredData.length - 1];
    return finish(
      {
        answered: true,
        // Deterministic one-line lead-in naming the part count; the parts
        // themselves live in sections, so the flat facts stay empty and the
        // flat links stay absent (renderers show the sections).
        proposition:
          sections.length === 1
            ? sections[0].action
              ? "Clerk has assembled this as a proposal — review and approve it below."
              : // A single act step whose assembly came back empty: there is
                // nothing to approve, so the lead-in must not promise it.
                "Clerk checked this for you — the details are below."
            : `This question has ${plural(sections.length, "part")} — each is answered separately below.`,
        facts: [],
        plan: outcomes.map((o) =>
          o.source === "data"
            ? { key: o.dataIntent.key, title: o.dataIntent.title }
            : { key: o.act.key, title: o.act.title },
        ),
        // Documented choice: a multi-part answer's follow-up scope is the
        // LAST answered data step's — "and for June?" after "X; also Y for
        // Acme" most naturally continues the trailing lookup.
        ...(lastAnswered ? { pins: pinsOf(lastAnswered.params) } : {}),
        sections,
        citation,
      },
      "approved",
    );
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
