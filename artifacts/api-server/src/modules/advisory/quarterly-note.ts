import { z } from "zod/v4";
import { isFeatureEnabled } from "../flags/flags";
import { CLERK_FLAG_KEY, type ClerkGateway } from "../clerk/gateway";
import { computeQuarterlyReview, type QuarterlyReview } from "./quarterly-pack";

// Quarterly review cover note (round-13 idea #4, second half). The review
// pack is deterministic end to end; this phrases it into a short letter body
// a partner can open the quarterly conversation with. Digest posture, the
// vat-note contract exactly:
//  - every figure comes from the computed pack — the model PHRASES, it never
//    computes, and the deterministic template always answers (kill switch,
//    missing gateway, budget, invalid output → template, never an error);
//  - nothing is stored — the partner edits the text and owns the letter;
//  - the pack's basis disclosure travels WITH the note.

const NOTE_PROMPT_VERSION = "quarterly-note.v1";
const NOTE_SYSTEM = [
  "You write a short quarterly review summary from a Nigerian accounting firm to open a client-book review conversation.",
  "Use ONLY the facts provided. Never add, change or estimate a number, date, deadline, rate or rule that is not in them.",
  "Do not give filing or legal advice beyond what the basis note says. Do not invent client names.",
  "Tone: professional, plain. 4 to 7 sentences, no greeting-name placeholders, no sign-off.",
  'Return JSON: {"note": string}.',
].join("\n");

const noteOutput = z.object({ note: z.string().min(1).max(2500) });

const noteJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["note"],
  properties: { note: { type: "string" } },
};

export interface QuarterlyReviewCoverNote {
  quarterStart: string;
  quarterLabel: string;
  note: string;
  source: "clerk" | "template";
  disclosure: string;
}

// The facts the model may phrase — nothing else reaches the prompt.
export function quarterlyNoteFacts(review: QuarterlyReview): string {
  const receivables = review.receivables.groups
    .map((g) => `${g.currency} ${g.outstandingTotal} across ${g.invoiceCount} invoice(s)`)
    .join("; ");
  const rejections =
    review.rejectionTotal > 0
      ? [
          `Rejected submission attempts: ${review.rejectionTotal}`,
          ...(review.topRejections.length > 0
            ? [
                `Most frequent rejection codes — ${review.topRejections
                  .map((r) => `${r.errorCode} (${r.count})`)
                  .join("; ")}`,
              ]
            : []),
        ]
      : [`Rejected submission attempts: 0`];
  return [
    `Quarter: ${review.quarterLabel}`,
    `Accepted invoices: ${review.vatTotals.acceptedCount}`,
    `Output VAT: NGN ${review.vatTotals.acceptedVat}, credits NGN ${review.vatTotals.creditVat}, net NGN ${review.vatTotals.netVat}`,
    `Accepted submission attempts: ${review.submissions.accepted}`,
    ...rejections,
    ...(receivables.length > 0
      ? [`Outstanding receivables as of ${review.receivables.asOf}: ${receivables}`]
      : [`Outstanding receivables as of ${review.receivables.asOf}: none`]),
    `Clerk captures opened in the quarter: ${review.clerk.captures} (${review.clerk.approved} approved, ${review.clerk.rejected} rejected)`,
    `Basis note: ${review.note}`,
  ].join("\n");
}

// The deterministic fallback — always a complete, sendable summary.
export function templateQuarterlyNote(review: QuarterlyReview): string {
  const rejectionLine =
    review.rejectionTotal > 0
      ? ` ${review.rejectionTotal} submission attempt(s) were rejected — the most frequent causes are listed in the pack.`
      : ` No submission attempts were rejected in the quarter.`;
  const receivablesLine =
    review.receivables.groups.length > 0
      ? ` Outstanding receivables as of ${review.receivables.asOf}: ${review.receivables.groups
          .map((g) => `${g.currency} ${g.outstandingTotal}`)
          .join(", ")}.`
      : ` No receivables were outstanding as of ${review.receivables.asOf}.`;
  return (
    `Quarterly review for ${review.quarterLabel}: ${review.vatTotals.acceptedCount} invoice(s) cleared the e-invoicing rails ` +
    `with net output VAT of NGN ${review.vatTotals.netVat} across the quarter's three monthly filing packs.` +
    rejectionLine +
    receivablesLine +
    ` Figures follow the attached pack's basis note — review together before acting on them.`
  );
}

export async function draftQuarterlyCoverNote(
  firmId: string,
  quarterStart: string,
  gateway: ClerkGateway | null,
): Promise<QuarterlyReviewCoverNote> {
  const review = await computeQuarterlyReview(firmId, quarterStart);
  const fallback: QuarterlyReviewCoverNote = {
    quarterStart: review.quarterStart,
    quarterLabel: review.quarterLabel,
    note: templateQuarterlyNote(review),
    source: "template",
    disclosure: review.note,
  };
  // A quarter with no accepted activity, no credits and no rejections has
  // nothing to phrase — a quiet quarter never calls the model (digest
  // posture). The credit term matches the vat-note quiet check: a
  // credits-only quarter (credit notes accepted after quarter close) is
  // activity, not quiet (round-13 review L4).
  if (
    review.vatTotals.acceptedCount === 0 &&
    Number(review.vatTotals.creditVat) === 0 &&
    review.submissions.accepted === 0 &&
    review.rejectionTotal === 0
  ) {
    return fallback;
  }
  if (!gateway || !(await isFeatureEnabled(CLERK_FLAG_KEY))) return fallback;

  const facts = quarterlyNoteFacts(review);
  // The try/catch closes the kill-switch TOCTOU: if clerk_ai flips off
  // between the check above and the call, the gateway's own assert throws —
  // and this surface must still answer with the template.
  try {
    const result = await gateway.infer<z.infer<typeof noteOutput>>({
      purpose: "draft_quarterly_note",
      caseId: null,
      // Firm work product — the firm's own allowance funds it. Deliberately
      // NO route budget pre-check: the gateway backstop turns an exhausted
      // allowance into a typed failure, which answers with the template.
      firmId,
      promptVersion: NOTE_PROMPT_VERSION,
      system: NOTE_SYSTEM,
      user: facts,
      schemaName: "quarterly_cover_note",
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
