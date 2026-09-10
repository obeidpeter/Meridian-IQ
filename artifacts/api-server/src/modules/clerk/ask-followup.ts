import { and, eq } from "drizzle-orm";
import { getDb, clerkCasesTable } from "@workspace/db";
import { inClerkScope } from "./scope";
import {
  stripCurrentMonth,
  type DataIntent,
  type MonthOption,
} from "./data-intents";
import type { AskAnswer, AskAnswerPins } from "./ask-answer";
import type { ClientOption } from "./ask-offer";

// Ask Clerk multi-turn context (R126, split from ask.ts; round-12 idea #3,
// pins-by-id since 0.56.0): the previous question case's PLATFORM-RECORDED
// intent and resolved scope, translated back into keys from THIS request's
// closed lists. Loaded under the same firm scope with an explicit firm
// filter, so a foreign or fabricated id yields no context; a previous scope
// no longer in the offered lists contributes nothing (never a raw id or
// name). Only data-intent answers carry context — claim answers need none.

async function loadPreviousAnswer(ctx: {
  previousCaseId: string;
  firmId: string;
  clientScoped: boolean;
  actorId: string;
}): Promise<AskAnswer | null | undefined> {
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
          eq(clerkCasesTable.id, ctx.previousCaseId),
          eq(clerkCasesTable.firmId, ctx.firmId),
          eq(clerkCasesTable.kind, "question"),
          // SEC-03: firm-keyed RLS shares the firm across sibling clients,
          // so a client asker's thread must ALSO be its own — a sibling's
          // case id contributes no context, exactly like a cross-firm id.
          ...(ctx.clientScoped
            ? [eq(clerkCasesTable.createdBy, ctx.actorId)]
            : []),
        ),
      )
      .limit(1),
  );
  return prev?.answer as AskAnswer | null | undefined;
}

// The lookup to thread: the flat single-intent key, or — for a
// multi-part answer — the last executed DATA step, the same step whose
// scope the stored pins carry (round 31: a plan may end in an act.*
// step, but an action proposal is never follow-up context — a trusted
// context line naming an act key would instruct the model to re-propose
// work the new question never asked for, the exact planted-step class
// the v7 rules forbid; an act-only previous answer contributes nothing).
function threadedIntent(
  prevAnswer: AskAnswer | null | undefined,
  dataIntents: readonly DataIntent[],
): string | undefined {
  const prevPlanDataKey = prevAnswer?.plan
    ? [...prevAnswer.plan]
        .reverse()
        .find((p) => dataIntents.some((i) => i.key === p.key))?.key
    : undefined;
  return prevAnswer?.dataIntent ?? prevPlanDataKey;
}

// ID-based recovery (the 0.56.0 fix): the stored pins carry the
// resolved monthStart and clientPartyId, validated against THIS
// request's live option lists — lagosMonthOptions has moved on for a
// year-old thread, and clientOptions is already SEC-03-narrowed for
// a client asker, so a stale or out-of-scope pin is DROPPED silently
// rather than trusted. Ids, not labels: two clients sharing a legal
// name resolve to the exact party the previous answer used, where
// label matching resolved whichever sorted first.
function scopeKeysFromPins(
  pins: AskAnswerPins,
  months: MonthOption[],
  clientOptions: ClientOption[],
): { prevMonthKey: string | null; prevClientKey: string | null } {
  const prevMonthKey = pins.monthStart
    ? (months.find((m) => m.monthStart === pins.monthStart)?.key ?? null)
    : null;
  const prevClientKey = pins.clientPartyId
    ? (clientOptions.find((c) => c.id === pins.clientPartyId)?.key ?? null)
    : null;
  return { prevMonthKey, prevClientKey };
}

// Legacy label matching, kept ONLY for pre-0.56 cases that stored no
// pins. The stored dataParams carry the resolved display LABELS
// (month label, client legal name) — map them back to THIS request's
// option keys; a label no longer in the offered lists contributes
// nothing. Stored month labels are stripped of CURRENT_MONTH_SUFFIX
// at answer time, so strip the offered labels the same way
// (stripCurrentMonth — the shared spelling) before comparing —
// otherwise a same-month follow-up silently loses its month scope.
function scopeKeysFromLabels(
  prevParams: Record<string, string> | undefined,
  months: MonthOption[],
  clientOptions: ClientOption[],
): { prevMonthKey: string | null; prevClientKey: string | null } {
  const prevMonthKey = prevParams?.month
    ? (months.find((m) => stripCurrentMonth(m.label) === prevParams.month)
        ?.key ?? null)
    : null;
  const prevClientKey = prevParams?.client
    ? (clientOptions.find((c) => c.name === prevParams.client)?.key ?? null)
    : null;
  return { prevMonthKey, prevClientKey };
}

function previousContextLines(
  prevIntent: string,
  prevMonthKey: string | null,
  prevClientKey: string | null,
): string[] {
  return [
    "",
    `Previous question context (platform-recorded): the asker's previous question used data key ${prevIntent}${prevMonthKey ? `, month ${prevMonthKey}` : ""}${prevClientKey ? `, client ${prevClientKey}` : ""}.`,
    'If THIS question is a follow-up that changes only the month or client (e.g. "and for June?", "what about <another client>?"), answer with the SAME data key and the new parameter keys, carrying over any parameter the question does not change. If it is a new question, ignore this context.',
  ];
}

// The context lines for the classifier prompt, or [] when there is no
// previous case to thread (no previousCaseId, a firm-less asker, or an
// asker offered no data intents), the previous case yields no answer under
// the SEC-03-aware lookup, or its intent is not among THIS request's keys.
export async function previousContextFor(ctx: {
  previousCaseId?: string | null;
  firmId?: string | null;
  clientScoped: boolean;
  actorId: string;
  dataIntents: readonly DataIntent[];
  keys: string[];
  months: MonthOption[];
  clientOptions: ClientOption[];
}): Promise<string[]> {
  if (ctx.previousCaseId && ctx.firmId && ctx.dataIntents.length > 0) {
    const prevAnswer = await loadPreviousAnswer({
      previousCaseId: ctx.previousCaseId,
      firmId: ctx.firmId,
      clientScoped: ctx.clientScoped,
      actorId: ctx.actorId,
    });
    const prevIntent = threadedIntent(prevAnswer, ctx.dataIntents);
    if (prevIntent && ctx.keys.includes(prevIntent)) {
      const pins = prevAnswer?.pins;
      const { prevMonthKey, prevClientKey } = pins
        ? scopeKeysFromPins(pins, ctx.months, ctx.clientOptions)
        : scopeKeysFromLabels(
            prevAnswer?.dataParams,
            ctx.months,
            ctx.clientOptions,
          );
      return previousContextLines(prevIntent, prevMonthKey, prevClientKey);
    }
  }
  return [];
}
