import { z } from "zod/v4";
import { fenceUntrusted } from "./prompts";

// Response Desk (Task #207): the letter-body half of an obligation response.
// The advisory-narrative posture exactly: facts are computed in SQL and
// injected verbatim, the model only phrases the BODY of a formal reply to a
// tax authority, ensureGrounded blocks any numeral the facts never stated,
// a deterministic template always answers, and the platform never sends or
// files anything — the partner copies, edits and owns the letter.
//
// This module holds the building blocks (facts type, prompt, template, and
// the RESPONSE_PHRASING seam the phrasing eval replays byte-identically);
// the orchestration that loads the obligation + period figures lives with
// the response-pack assembly in modules/obligations/.

export const RESPONSE_LETTER_PROMPT_VERSION = "response-letter.v1";

export const RESPONSE_LETTER_SYSTEM = [
  "You draft the BODY of a formal reply from a Nigerian accounting firm to a tax-authority notice concerning its client.",
  "Use ONLY the facts provided. Never invent, change or estimate an amount, date, reference number or filing position that is not in them.",
  "Make no admissions, undertakings or commitments beyond what the facts state; where the records support the client's position, say so plainly and refer to the enclosed bundle.",
  "No letterhead, greeting, sign-off or placeholders — body text only; the firm adds those. Three to five short, formal paragraphs.",
  'Return JSON: {"letter": string}.',
].join("\n");

export const letterOutput = z.object({
  letter: z.string().min(1).max(4000),
});

export const RESPONSE_LETTER_JSON_SCHEMA = {
  type: "object",
  properties: { letter: { type: "string" } },
  required: ["letter"],
  additionalProperties: false,
} as const;

// The facts the letter is allowed to speak from. The obligation block is
// outsider-influenced free text (values read off the authority's own letter,
// plus firm-staff notes) and is fenced in the prompt; packLines are the
// period's figure lines, pre-rendered "Label: value" by the response-pack
// assembly so a stored eval fixture replays the exact production prompt.
export interface ResponseLetterFacts {
  obligation: {
    authority: string;
    noticeType: string;
    reference: string | null;
    taxType: string | null;
    period: string | null;
    amount: string | null;
    currency: string | null;
    issueDate: string | null;
    responseDueDate: string;
    notes: string | null;
  };
  clientName: string;
  firmName: string;
  monthLabel: string;
  packLines: string[];
}

const line = (label: string, value: string | null | undefined): string | null =>
  value ? `${label}: ${value}` : null;

export interface ObligationNoticeRow {
  label: string;
  value: string;
}

// The notice fields both authority-facing renderings share — the letter's
// fenced NOTICE block below and the response bundle cover's kv rows
// (response-pack-pdf.ts) — with presence logic and the amount composition in
// ONE home, so a renamed label or changed format can never drift the letter
// from the paper it is enclosed with. Absent optional fields are dropped
// (authority/noticeType/responseDueDate are notNull in the schema, so they
// always survive). PROMPT BYTES: the letter renders these rows verbatim
// inside its fence — editing labels, order or composition changes prompt
// bytes and requires a RESPONSE_LETTER_PROMPT_VERSION bump. Firm notes stays
// OUT of this list deliberately: the letter fences it for the model while
// the bundle never prints firm-internal notes on authority-facing paper.
export function obligationNoticeRows(
  o: ResponseLetterFacts["obligation"],
): ObligationNoticeRow[] {
  const row = (
    label: string,
    value: string | null | undefined,
  ): ObligationNoticeRow | null => (value ? { label, value } : null);
  return [
    row("Authority", o.authority),
    row("Notice type", o.noticeType),
    row("Reference", o.reference),
    row("Tax type", o.taxType),
    row("Period on the notice", o.period),
    row(
      "Amount on the notice",
      o.amount ? `${o.amount}${o.currency ? ` ${o.currency}` : ""}` : null,
    ),
    row("Notice date", o.issueDate),
    row("Response due", o.responseDueDate),
  ].filter((r): r is ObligationNoticeRow => r !== null);
}

export function buildResponseLetterUser(facts: ResponseLetterFacts): string {
  const o = facts.obligation;
  const noticeLines = [
    ...obligationNoticeRows(o).map((r) => `${r.label}: ${r.value}`),
    line("Firm notes", o.notes),
  ].filter((l): l is string => l !== null);
  return [
    `Client: ${facts.clientName}`,
    `Firm: ${facts.firmName}`,
    `Period covered by the enclosed figures: ${facts.monthLabel}`,
    fenceUntrusted(
      "tax-authority notice details",
      "NOTICE",
      noticeLines.join("\n"),
    ),
    ...facts.packLines,
  ].join("\n");
}

// The deterministic fallback: a complete, honest letter body assembled from
// the same facts, so "Clerk unavailable" never blocks a response.
export function buildTemplateResponseLetter(
  facts: ResponseLetterFacts,
): string {
  const o = facts.obligation;
  const refClause = o.reference ? ` with reference ${o.reference}` : "";
  const dateClause = o.issueDate ? ` dated ${o.issueDate}` : "";
  const scopeClause =
    o.taxType || o.period
      ? ` concerning ${[o.taxType, o.period].filter(Boolean).join(", ")}`
      : "";
  const paragraphs = [
    `We refer to the ${o.noticeType} notice${dateClause}${refClause} issued to our client ${facts.clientName}${scopeClause}.`,
    `Our client's records for ${facts.monthLabel} are set out in the enclosed response bundle, which contains the period's document register and compliance computations.`,
    `We request that the position reflected in the enclosed records be taken into account, and we are available to provide any further information required before ${o.responseDueDate}.`,
  ];
  return paragraphs.join("\n\n");
}

// The phrasing-eval seam: MUST reference the same objects production sends
// (cover-note.ts rule) so the eval replays the exact prompt bytes.
export const RESPONSE_PHRASING = {
  surface: "obligation_response" as const,
  promptVersion: RESPONSE_LETTER_PROMPT_VERSION,
  system: RESPONSE_LETTER_SYSTEM,
  schemaName: "response_letter",
  jsonSchema: RESPONSE_LETTER_JSON_SCHEMA,
  validator: letterOutput,
  buildUser: (facts: ResponseLetterFacts): string =>
    buildResponseLetterUser(facts),
  joinOutput: (data: { letter: string }): string => data.letter,
};
