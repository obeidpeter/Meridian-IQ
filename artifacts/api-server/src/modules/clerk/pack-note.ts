import { z } from "zod/v4";
import { isFeatureEnabled } from "../flags/flags";
import { ensureGrounded } from "./grounding";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import {
  computeCompliancePack,
  type CompliancePackFacts,
} from "../invoice/compliance-pack";

// Compliance-pack cover note (compliance round). The monthly client pack is
// deterministic end to end; this phrases it into a note a partner can send
// over the PDF. Digest posture, stated once (the vat-note.ts shape):
//  - every figure comes from the computed pack — the model PHRASES, it never
//    computes, and the deterministic template always answers (kill switch,
//    missing gateway, budget, invalid output → template, never an error);
//  - nothing is stored — the note lives inside the rendered PDF only;
//  - the pack's VAT basis disclosure travels WITH the note so the caveats
//    can't be lost when the paper is handed around.

const PACK_NOTE_PROMPT_VERSION = "pack-note.v1";
const NOTE_SYSTEM = [
  "You write a short cover note from a Nigerian accounting firm to accompany one client's monthly compliance pack.",
  "Use ONLY the facts provided. Never add, change or estimate a number, date, deadline, rate or rule that is not in them.",
  "Do not give filing or payment advice beyond what the numbers themselves say. Do not invent client or firm names.",
  "Tone: professional, plain. 3 to 6 sentences, no greeting-name placeholders, no sign-off.",
  'Return JSON: {"note": string}.',
].join("\n");

const noteOutput = z.object({ note: z.string().min(1).max(2000) });

const noteJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["note"],
  properties: { note: { type: "string" } },
};

export interface CompliancePackCoverNote {
  monthStart: string;
  monthLabel: string;
  note: string;
  source: "clerk" | "template";
  // The pack's VAT basis note — travels with the text so the caveats survive.
  disclosure: string;
}

// The facts the model may phrase — nothing else reaches the prompt.
export function packNoteFacts(facts: CompliancePackFacts): string {
  const receivables = facts.receivables.groups.map(
    (g) => `${g.currency} ${g.outstandingTotal} across ${g.invoiceCount} invoice(s)`,
  );
  const payables = facts.payables.groups.map(
    (g) => `${g.currency} ${g.total.amount} across ${g.total.count} bill(s)`,
  );
  return [
    `Month: ${facts.monthLabel}`,
    `Client: ${facts.clientName}`,
    `Documents issued in the month: ${facts.register.rows.length}${
      facts.register.truncated ? " or more (register truncated in the pack)" : ""
    }`,
    `Outstanding receivables: ${receivables.length > 0 ? receivables.join("; ") : "none"}`,
    `Unpaid supplier bills: ${payables.length > 0 ? payables.join("; ") : "none"}`,
    `Output VAT: NGN ${facts.vat.outputVat}`,
    `Input VAT: NGN ${facts.vat.inputVat} (verified NGN ${facts.vat.inputVatVerified})`,
    `Net VAT position: NGN ${facts.vat.netVat} (defensible NGN ${facts.vat.defensibleNetVat})`,
    `Documents awaiting submission: ${facts.deadlines.unsubmittedReceivables}`,
    `Next VAT return due: ${facts.deadlines.nextVatReturnDue}`,
    `Basis note: ${facts.vat.note}`,
  ].join("\n");
}

// The deterministic fallback — always a complete, sendable note.
export function templatePackNote(facts: CompliancePackFacts): string {
  const backlog =
    facts.deadlines.unsubmittedReceivables > 0
      ? ` ${facts.deadlines.unsubmittedReceivables} document(s) still await submission to the e-invoicing rails.`
      : "";
  return (
    `Please find attached the ${facts.monthLabel} compliance pack for ${facts.clientName}. ` +
    `It covers ${facts.register.rows.length} document(s) issued in the month, the outstanding receivables and unpaid supplier bills, ` +
    `and a VAT position of NGN ${facts.vat.netVat} net (NGN ${facts.vat.defensibleNetVat} counting verified input VAT only).${backlog} ` +
    `The next VAT return is due ${facts.deadlines.nextVatReturnDue}. ` +
    `Figures are a preparation aid computed on the basis described in the pack — reconcile before filing.`
  );
}

// `precomputed` lets the pack route hand over the facts it already computed
// for the PDF render instead of re-running the aggregates; standalone callers
// omit it and get the vat-note.ts four-argument shape.
export async function draftPackCoverNote(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
  gateway: ClerkGateway | null,
  precomputed?: CompliancePackFacts,
): Promise<CompliancePackCoverNote> {
  const facts =
    precomputed ?? (await computeCompliancePack(firmId, clientPartyId, monthStart));
  const fallback: CompliancePackCoverNote = {
    monthStart: facts.monthStart,
    monthLabel: facts.monthLabel,
    note: templatePackNote(facts),
    source: "template",
    disclosure: facts.vat.note,
  };
  // A month with no issued documents and no captured bills has nothing to
  // phrase — and spending tokens to say "nothing happened" is the digest
  // anti-pattern.
  if (facts.register.rows.length === 0 && facts.vat.billCount === 0) {
    return fallback;
  }
  if (!gateway || !(await isFeatureEnabled(CLERK_FLAG_KEY))) return fallback;

  const factsText = packNoteFacts(facts);
  // The try/catch closes the kill-switch TOCTOU: if clerk_ai flips off
  // between the check above and the call, the gateway's own assert throws —
  // and for this surface even that must answer with the template.
  try {
    const result = await gateway.infer<z.infer<typeof noteOutput>>({
      purpose: "draft_pack_note",
      caseId: null,
      // Firm work product, so the firm's own allowance funds it. There is
      // deliberately NO route budget pre-check: the gateway backstop turns
      // an exhausted allowance into a typed failure, which answers with the
      // template below — never a 429 (see the route comment).
      firmId,
      promptVersion: PACK_NOTE_PROMPT_VERSION,
      system: NOTE_SYSTEM,
      user: factsText,
      schemaName: "pack_cover_note",
      jsonSchema: noteJsonSchema,
      validator: noteOutput,
      inputForHash: factsText,
    });
    // Number grounding: a numeral the facts never stated → template answers
    // (grounding.ts).
    if (
      !result.ok ||
      !(await ensureGrounded("pack_note", firmId, result.data.note, factsText))
    ) {
      return fallback;
    }
    return { ...fallback, note: result.data.note, source: "clerk" };
  } catch {
    return fallback;
  }
}
