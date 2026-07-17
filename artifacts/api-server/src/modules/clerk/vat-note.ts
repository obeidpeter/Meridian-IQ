import { z } from "zod/v4";
import { isFeatureEnabled } from "../flags/flags";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { computeVatPack, type VatPack } from "./vat-pack";

// VAT filing cover note (round-4 idea #6). The VAT pack is deterministic end
// to end; this phrases it into a note a partner can paste over the pack when
// they send it on. Digest posture, stated once:
//  - every figure comes from the computed pack — the model PHRASES, it never
//    computes, and the deterministic template always answers (kill switch,
//    missing gateway, budget, invalid output → template, never an error);
//  - nothing is stored — the partner edits the text and owns the letter;
//  - the pack's basis disclosure travels WITH the note so the caveats can't
//    be lost in the paste.

const NOTE_PROMPT_VERSION = "vat-note.v1";
const NOTE_SYSTEM = [
  "You write a short cover note from a Nigerian accounting firm to accompany its monthly VAT filing pack.",
  "Use ONLY the facts provided. Never add, change or estimate a number, date, deadline, rate or rule that is not in them.",
  "Do not give filing advice beyond what the basis note says. Do not invent client names.",
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

export interface VatPackCoverNote {
  monthStart: string;
  monthLabel: string;
  note: string;
  source: "clerk" | "template";
  // The pack's basis note — travels with the text so the caveats survive.
  disclosure: string;
}

// The facts the model may phrase — nothing else reaches the prompt.
export function vatNoteFacts(pack: VatPack): string {
  const top = [...pack.rows]
    .sort((a, b) => Number(b.netVat) - Number(a.netVat))
    .slice(0, 3)
    .map((r) => `${r.clientName}: net output VAT NGN ${r.netVat}`);
  return [
    `Month: ${pack.monthLabel}`,
    `Clients with accepted activity: ${pack.rows.length}`,
    `Accepted invoices: ${pack.totals.acceptedCount} totalling NGN ${pack.totals.acceptedTotal}`,
    `Output VAT: NGN ${pack.totals.acceptedVat}`,
    `Credit notes: ${pack.totals.creditCount} reducing VAT by NGN ${pack.totals.creditVat}`,
    `Net output VAT: NGN ${pack.totals.netVat}`,
    ...(top.length > 0 ? [`Largest clients by net VAT — ${top.join("; ")}`] : []),
    `Basis note: ${pack.note}`,
  ].join("\n");
}

// The deterministic fallback — always a complete, sendable note.
export function templateVatNote(pack: VatPack): string {
  const credits =
    pack.totals.creditCount > 0
      ? ` ${pack.totals.creditCount} credit note(s) reduce it by NGN ${pack.totals.creditVat}, leaving net output VAT of NGN ${pack.totals.netVat}.`
      : ` Net output VAT is NGN ${pack.totals.netVat}.`;
  return (
    `Please find attached the VAT filing pack for ${pack.monthLabel}. ` +
    `${pack.totals.acceptedCount} invoice(s) across ${pack.rows.length} client(s) cleared the e-invoicing rails, ` +
    `with output VAT of NGN ${pack.totals.acceptedVat}.${credits} ` +
    `Figures are a preparation aid computed on the issue-month basis described in the attached note — reconcile before filing.`
  );
}

export async function draftVatCoverNote(
  firmId: string,
  monthStart: string,
  gateway: ClerkGateway | null,
): Promise<VatPackCoverNote> {
  const pack = await computeVatPack(firmId, monthStart);
  const fallback: VatPackCoverNote = {
    monthStart: pack.monthStart,
    monthLabel: pack.monthLabel,
    note: templateVatNote(pack),
    source: "template",
    disclosure: pack.note,
  };
  // A month with no accepted activity has nothing to phrase — and spending
  // tokens to say "nothing happened" is the digest anti-pattern.
  if (pack.totals.acceptedCount === 0 && pack.totals.creditCount === 0) {
    return fallback;
  }
  if (!gateway || !(await isFeatureEnabled(CLERK_FLAG_KEY))) return fallback;

  const facts = vatNoteFacts(pack);
  // The try/catch closes the kill-switch TOCTOU: if clerk_ai flips off
  // between the check above and the call, the gateway's own assert throws —
  // and for this surface even that must answer with the template.
  try {
    const result = await gateway.infer<z.infer<typeof noteOutput>>({
      purpose: "draft_vat_note",
      caseId: null,
      // Firm work product, so the firm's own allowance funds it. There is
      // deliberately NO route budget pre-check: the gateway backstop turns
      // an exhausted allowance into a typed failure, which answers with the
      // template below — never a 429 (see the route comment).
      firmId,
      promptVersion: NOTE_PROMPT_VERSION,
      system: NOTE_SYSTEM,
      user: facts,
      schemaName: "vat_cover_note",
      jsonSchema: noteJsonSchema,
      validator: noteOutput,
      inputForHash: facts,
    });
    if (!result.ok) return fallback;
    return { ...fallback, note: result.data.note, source: "clerk" };
  } catch {
    return fallback;
  }
}
