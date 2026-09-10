import { logger } from "../../lib/logger";
import { inClerkScope } from "./scope";
import {
  extractInvoiceNumbers,
  stripCurrentMonth,
  type DataIntent,
  type DataIntentParams,
  type DataIntentResult,
  type MonthOption,
} from "./data-intents";
import type { PlanStep } from "./prompts";
import {
  proposalForKind,
  type ActionIntent,
  type ActionProposal,
} from "./actions";
import type { ClientOption } from "./ask-offer";

// Ask Clerk step execution (R126, split from ask.ts): each planned data or
// act.* step resolves the model's closed-key picks back through the app's
// OWN option lists and runs the lookup (or mines the proposal) under the
// asker's firm scope. Refusal reasons are returned, not thrown — ask-answer
// decides whether a reason refuses the whole case or becomes a section.

// One step's execution, with a FRESH DataIntentParams per step (the
// 0.56.0 fix: the old single shared params object would have leaked one
// step's month/client into the next). Refusal reasons are returned, not
// thrown: a single-step plan refuses the whole case with them verbatim
// (the claim-gaps sentence catalogue), a multi-step plan turns them into
// a could-not-answer section.
export type StepOutcome =
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

// A plan step resolved against the intents THIS asker was OFFERED (ask.ts):
// exactly one of dataIntent / actionIntent is set for a step that reaches
// the runner.
export interface PlannedStep {
  step: PlanStep;
  dataIntent?: DataIntent;
  actionIntent?: ActionIntent;
}

// Everything a step needs from the request: the firm scope, the raw
// question (invoice numbers are app-extracted from it), the SEC-03 posture
// (clientScoped = the principal is a client_user; clientOptions is already
// narrowed to its own party) and the closed option maps the picks resolve
// through.
export interface StepContext {
  firmId: string;
  question: string;
  clientScoped: boolean;
  clientPartyId?: string | null;
  monthByKey: Map<string, MonthOption>;
  clientByKey: Map<string, ClientOption>;
  clientOptions: ClientOption[];
}

export async function runDataStep(
  ctx: StepContext,
  dataIntent: DataIntent,
  step: PlanStep,
): Promise<StepOutcome> {
  // Parameter resolution (idea #4): the model picked closed keys; the
  // app maps them back through ITS OWN option lists. An unknown key, or
  // a param the chosen lookup cannot honour, refuses — never a silently
  // unfiltered answer pretending to be a filtered one.
  const params: DataIntentParams = {};
  if (step.month !== "none") {
    const month = ctx.monthByKey.get(step.month);
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
    const client = ctx.clientByKey.get(step.client);
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
  if (ctx.clientScoped && ctx.clientPartyId) {
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
    const own = ctx.clientOptions.find((c) => c.id === ctx.clientPartyId);
    if (own) params.clientName = own.name;
  }
  // Invoice-pinned lookup (round 20): the number is APP-EXTRACTED from
  // the RAW question by a regex — the model only picked the key, and
  // nothing model-authored reaches the lookup. No number, or several,
  // refuses rather than guessing. Applied ONLY to a data.invoice_status
  // step, exactly as before plans.
  if (dataIntent.key === "data.invoice_status") {
    const numbers = extractInvoiceNumbers(ctx.question);
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
    const lookup = await inClerkScope(ctx.firmId, () =>
      dataIntent.run(ctx.firmId, params),
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
}

// Do with Clerk (round 31): resolve one act.* step to a live proposal.
// The same closed-option client resolution as data steps (a client asker
// is FORCED to its own party; a firm asker must name a listed client —
// action batches are assembled per client, exactly like the existing
// proposal surface). proposalForKind is read-only SQL mining; the model
// never sees the result, and nothing here executes.
export async function runActStep(
  ctx: StepContext,
  act: ActionIntent,
  step: PlanStep,
): Promise<StepOutcome> {
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
  if (ctx.clientScoped && ctx.clientPartyId) {
    clientPartyId = ctx.clientPartyId;
    clientName =
      ctx.clientOptions.find((c) => c.id === ctx.clientPartyId)?.name ?? "";
  } else if (step.client !== "none") {
    const client = ctx.clientByKey.get(step.client);
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
    const proposal = await inClerkScope(ctx.firmId, () =>
      proposalForKind(act.kind, ctx.firmId, clientPartyId!),
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
}

// Sequential, in plan order — later sections may narrate later months,
// and the lookups share the caller's firm scope, not each other's params.
export async function runPlanSteps(
  ctx: StepContext,
  planned: PlannedStep[],
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const p of planned) {
    outcomes.push(
      p.dataIntent
        ? await runDataStep(ctx, p.dataIntent, p.step)
        : await runActStep(ctx, p.actionIntent!, p.step),
    );
  }
  return outcomes;
}
