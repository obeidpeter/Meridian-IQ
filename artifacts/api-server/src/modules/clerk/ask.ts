import { and, eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  engagementsTable,
  partiesTable,
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
import {
  getDataIntent,
  lagosMonthOptions,
  DATA_INTENTS,
  type DataIntentParams,
} from "./data-intents";
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
  // previousCaseId (round-12 idea #3, multi-turn): the asker's prior
  // question case in this thread — loaded under the SAME firm scope, and
  // only its platform-recorded intent + resolved parameter KEYS reach the
  // classifier as context, so "and for June?" can follow on. Conversation
  // state lives entirely in data the app already stores.
  ctx: { firmId?: string | null; previousCaseId?: string | null } = {},
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

  // Closed parameter options (idea #4), offered only alongside data intents:
  // the last twelve Lagos months, and the firm's own client parties under
  // OPAQUE keys the app maps back — the model can only ever pick an entry
  // the app itself built.
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
            .where(eq(engagementsTable.firmId, ctx.firmId!))
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

  // Multi-turn context (round-12 idea #3): the previous question case's
  // PLATFORM-RECORDED intent and resolved parameters, translated back into
  // keys from THIS request's closed lists. Loaded under the same firm scope
  // with an explicit firm filter, so a foreign or fabricated id yields no
  // context; a previous client no longer in the offered list contributes no
  // client key (never a raw id or name). Only data-intent answers carry
  // context — claim answers need none.
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
          ),
        )
        .limit(1),
    );
    const prevIntent = prev?.answer?.dataIntent;
    if (prevIntent && keys.includes(prevIntent)) {
      // The stored dataParams carry the resolved display LABELS (month label,
      // client legal name) — map them back to THIS request's option keys; a
      // label no longer in the offered lists contributes nothing. Stored
      // month labels are stripped of the " (current month)" suffix at answer
      // time, so strip the offered labels the same way before comparing —
      // otherwise a same-month follow-up silently loses its month scope.
      const prevParams = prev?.answer?.dataParams;
      const prevMonthKey = prevParams?.month
        ? (months.find(
            (m) =>
              m.label.replace(" (current month)", "") === prevParams.month,
          )?.key ?? null)
        : null;
      const prevClientKey = prevParams?.client
        ? (clientOptions.find((c) => c.name === prevParams.client)?.key ??
          null)
        : null;
      previousContext = [
        "",
        `Previous question context (platform-recorded): the asker's previous question used data key ${prevIntent}${prevMonthKey ? `, month ${prevMonthKey}` : ""}${prevClientKey ? `, client ${prevClientKey}` : ""}.`,
        'If THIS question is a follow-up that changes only the month or client (e.g. "and for June?", "what about <another client>?"), answer with the SAME data key and the new parameter keys, carrying over any parameter the question does not change. If it is a new question, ignore this context.',
      ];
    }
  }

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
          "",
          "Month keys (for data lookups that take a month):",
          months.map((m) => `- ${m.key}: ${m.label}`).join("\n"),
          ...(clientOptions.length > 0
            ? [
                "",
                "Client keys (the asker's own clients, for data lookups):",
                // Client legal names are user-authored — they ride inside a
                // fence so a name can never smuggle instructions; the c1..cN
                // keys around them are app-built and trusted.
                fenceUntrusted(
                  "client name directory (match names to keys only)",
                  "CLIENT_NAMES",
                  clientOptions.map((c) => `- ${c.key}: ${c.name}`).join("\n"),
                ),
                ...(clientsTruncated
                  ? [
                      'This client list is INCOMPLETE. If the question names a client that is not listed, answer claimKey "none" — never answer a client-scoped question firm-wide.',
                    ]
                  : []),
              ]
            : []),
        ]
      : []),
    ...previousContext,
    "",
    fenceUntrusted("question", "QUESTION", question),
  ].join("\n");

  const monthKeys = months.map((m) => m.key);
  const clientKeys = clientOptions.map((c) => c.key);
  const result = await gateway.infer<IntentOutput>({
    purpose: "classify_intent",
    caseId: created.id,
    firmId: ctx.firmId ?? null,
    promptVersion: INTENT_PROMPT_VERSION,
    system: INTENT_SYSTEM,
    user,
    schemaName: "intent_classification",
    jsonSchema: intentJsonSchema(keys, monthKeys, clientKeys),
    validator: intentValidator(keys, monthKeys, clientKeys) as never,
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
    // Parameter resolution (idea #4): the model picked closed keys; the app
    // maps them back through ITS OWN option lists. An unknown key, or a
    // param the chosen lookup cannot honour, refuses — never a silently
    // unfiltered answer pretending to be a filtered one.
    const monthKey = result.data.month ?? "none";
    const clientKey = result.data.client ?? "none";
    const params: DataIntentParams = {};
    if (monthKey !== "none") {
      const month = monthByKey.get(monthKey);
      if (!month) {
        return refuse(
          "The month in the question could not be resolved, so it has been escalated to an operator.",
        );
      }
      if (!dataIntent.accepts.month) {
        return refuse(
          "That lookup always answers as of today and cannot be filtered to a month. Ask about rail submissions for month-by-month figures.",
        );
      }
      params.monthStart = month.monthStart;
      params.monthLabel = month.label.replace(" (current month)", "");
    }
    if (clientKey !== "none") {
      const client = clientByKey.get(clientKey);
      if (!client) {
        return refuse(
          "The client named in the question could not be resolved, so it has been escalated to an operator.",
        );
      }
      if (!dataIntent.accepts.client) {
        return refuse(
          "That lookup covers the whole firm and cannot be filtered to one client.",
        );
      }
      params.clientPartyId = client.id;
      params.clientName = client.name;
    }

    let outcome;
    try {
      // The lookup runs in the SAME firm-scoped RLS posture as the request
      // (and every query also filters firm_id explicitly) — the asker can
      // only ever see numbers computed from its own firm's rows.
      outcome = await inClerkScope(firmId, () =>
        dataIntent.run(firmId, params),
      );
    } catch (err) {
      logger.warn(
        { err, dataIntent: dataIntent.key },
        "ask clerk: data-intent lookup failed",
      );
      return refuse(
        "The firm-record lookup failed, so the question has been escalated to an operator.",
      );
    }
    const dataParams = {
      ...(params.monthLabel ? { month: params.monthLabel } : {}),
      ...(params.clientName ? { client: params.clientName } : {}),
    };
    return finish(
      {
        answered: true,
        dataIntent: dataIntent.key,
        ...(Object.keys(dataParams).length > 0 ? { dataParams } : {}),
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
