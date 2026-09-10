import type {
  ClerkAnswer,
  ClerkAnswerLink,
  ProtectedFact,
} from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import type { AskAnswerMemory } from "./ask-memory";
import type { DataIntentParams } from "./data-intents";
import type { ActionKind } from "./actions";
import type { StepOutcome } from "./ask-steps";
import { plural } from "./text";

// Ask Clerk answer assembly (R126, split from ask.ts): the contract-mirroring
// answer shape and the deterministic fold from step outcomes to ONE answer
// (or ONE bare refusal reason — ask.ts adds the refusal prefix and
// escalates). No model involvement anywhere in this file.

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
  // Retrieval-augmented Ask (round 47, contract 0.73.0): similar past
  // questions, attached by app code AFTER the answer is complete — see
  // ask-memory.ts for the posture (pointer-first, SEC-03 own-cases pin for
  // client askers, best-effort).
  memory?: AskAnswerMemory;
};

function displayParams(
  params: DataIntentParams,
): Record<string, string> | undefined {
  const d = {
    ...(params.monthLabel ? { month: params.monthLabel } : {}),
    ...(params.clientName ? { client: params.clientName } : {}),
  };
  return Object.keys(d).length > 0 ? d : undefined;
}

// The resolved scope BY ID (contract pins): what a follow-up re-pins
// from, validated against the then-live option lists before use.
function pinsOf(params: DataIntentParams): AskAnswerPins {
  return {
    ...(params.monthStart
      ? { monthStart: params.monthStart, monthLabel: params.monthLabel }
      : {}),
    ...(params.clientPartyId
      ? {
          clientPartyId: params.clientPartyId,
          ...(params.clientName ? { clientName: params.clientName } : {}),
        }
      : {}),
  };
}

// One section per executed step, in plan order. A refused step keeps its
// slot with an honest could-not-answer text (its escalation clause
// stripped — the case is APPROVED when any part answered, so the sentence
// must not claim an escalation that did not happen; the clause is ask.ts's
// own pinned constant, see claim-gaps.test.ts).
function sectionFor(o: StepOutcome): AskAnswerSection {
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
}

// Deterministic one-line lead-in naming the part count; the parts
// themselves live in sections, so the flat facts stay empty and the
// flat links stay absent (renderers show the sections).
function leadInFor(sections: AskAnswerSection[]): string {
  return sections.length === 1
    ? sections[0].action
      ? "Clerk has assembled this as a proposal — review and approve it below."
      : // A single act step whose assembly came back empty: there is
        // nothing to approve, so the lead-in must not promise it.
        "Clerk checked this for you — the details are below."
    : `This question has ${plural(sections.length, "part")} — each is answered separately below.`;
}

// Single DATA step: EXACTLY the pre-plan flat answer shape (plus pins),
// so every existing consumer, fixture and follow-up behaves identically.
function flatDataAnswer(
  only: Extract<StepOutcome, { ok: true; source: "data" }>,
  citation: string,
): AskAnswer {
  const dataParams = displayParams(only.params);
  return {
    answered: true,
    dataIntent: only.dataIntent.key,
    ...(dataParams ? { dataParams } : {}),
    proposition: only.result.text,
    facts: only.result.facts,
    // Open-the-invoice links (round 7), app-built from the lookup's
    // own sample rows. The lookup already ran firm/SEC-03-scoped (and
    // a client asker's party was FORCED by the step runner), so every
    // id here is an invoice the asker may already see.
    ...(only.result.links && only.result.links.length > 0
      ? { links: only.result.links }
      : {}),
    citation,
    pins: pinsOf(only.params),
  };
}

// Multi-part answer: one section per executed step, in plan order.
function multiPartAnswer(
  outcomes: StepOutcome[],
  answeredSteps: Extract<StepOutcome, { ok: true }>[],
  citation: string,
): AskAnswer {
  const sections: AskAnswerSection[] = outcomes.map(sectionFor);
  // Follow-up pins come from the LAST answered DATA step — an action
  // proposal pins nothing (its scope lives on its own section, and "and
  // for June?" after an approval prompt is not a thing).
  const answeredData = answeredSteps.filter(
    (o): o is Extract<StepOutcome, { ok: true; source: "data" }> =>
      o.source === "data",
  );
  const lastAnswered = answeredData[answeredData.length - 1];
  return {
    answered: true,
    proposition: leadInFor(sections),
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
  };
}

// The fold from step outcomes to ONE answer or ONE bare refusal reason
// (ask.ts prefixes it and escalates the case). Single-step refusal (either
// source) refuses the whole case with the step's reason verbatim; a single
// answered DATA step answers in the flat shape; a single answered ACT step
// falls through to the sections shape: an action proposal is inherently
// sectional (the approve payload lives on the section), and no
// pre-round-31 consumer ever saw an act.* key, so there is no flat shape
// to preserve. Every step refused: the whole case refuses with the FIRST
// reason — one neutral escalation, exactly like a single-step refusal.
export function resolveOutcomes(
  outcomes: StepOutcome[],
): { refuse: string } | { answer: AskAnswer } {
  const citation = `Computed live from your firm's records on ${lagosDateString()} (Lagos)`;
  if (outcomes.length === 1 && !outcomes[0].ok) {
    return { refuse: outcomes[0].reason };
  }
  if (outcomes.length === 1 && outcomes[0].source === "data") {
    const only = outcomes[0] as Extract<
      StepOutcome,
      { ok: true; source: "data" }
    >;
    return { answer: flatDataAnswer(only, citation) };
  }
  const answeredSteps = outcomes.filter(
    (o): o is Extract<StepOutcome, { ok: true }> => o.ok,
  );
  if (answeredSteps.length === 0) {
    const first = outcomes[0] as Extract<StepOutcome, { ok: false }>;
    return { refuse: first.reason };
  }
  return { answer: multiPartAnswer(outcomes, answeredSteps, citation) };
}
