import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb, invoicesTable, partiesTable } from "@workspace/db";
import { DomainError } from "../errors";
import {
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../auth/rbac";
import { lagosDateString } from "../../lib/lagos-time";
import {
  buyerPaymentBehaviour,
  type BuyerPaymentBehaviour,
} from "../invoice/payment-behaviour";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { isFeatureEnabled } from "../flags/flags";

// Payment-chaser drafts (round-9 idea #2). The receivables card says "chase
// payment" and leaves the awkward letter to the client; this writes it.
// Digest posture, stated once:
//  - every figure comes from the stored invoice + the payment-behaviour
//    miner — the model PHRASES, it never computes, and the deterministic
//    template always answers (kill switch, missing gateway, budget,
//    invalid output → template, never an error);
//  - nothing is stored — the client copies the text into their own email
//    and owns what is sent;
//  - eligibility is the receivables definition exactly (issued and not yet
//    settled/dead), so this button can never chase a paid invoice.
// The behaviour hint turns "you are late" into "this one is outside your
// usual rhythm" — a materially softer, more effective letter.

const CHASER_PROMPT_VERSION = "chaser.v1";
const CHASER_SYSTEM = [
  "You write a short, polite payment reminder from a Nigerian small business to one of its customers.",
  "Use ONLY the facts provided. Never add, change or estimate an amount, date, invoice number, bank detail or payment method that is not in them.",
  "Never threaten, never mention interest, penalties or legal action.",
  "If the facts include the customer's usual payment timing, you may reference it gently.",
  "End by asking them to disregard the note if payment is already on its way.",
  "Tone: warm, professional, direct. 3 to 6 sentences. No placeholders.",
  'Return JSON: {"subject": string, "body": string}.',
].join("\n");

const chaserOutput = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});

const chaserJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
};

export interface PaymentChaserDraft {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  subject: string;
  body: string;
  source: "clerk" | "template";
}

// The receivables definition, mirrored from receivables.ts: issued to the
// buyer and payment not yet observed.
const OUTSTANDING_STATUSES = new Set(["submitted", "stamped", "confirmed"]);

interface ChaserFactsInput {
  invoiceNumber: string;
  buyerName: string;
  currency: string;
  grandTotal: string;
  issueDate: string;
  dueDate: string | null;
  today: string;
  behaviour: BuyerPaymentBehaviour | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

// The facts the model may phrase — nothing else reaches the prompt. Pure and
// exported for tests.
export function chaserFacts(input: ChaserFactsInput): string {
  const refDate = input.dueDate ?? input.issueDate;
  const ageDays = daysBetween(refDate, input.today);
  const lines = [
    `Customer: ${input.buyerName}`,
    `Invoice number: ${input.invoiceNumber}`,
    `Amount: ${input.currency} ${input.grandTotal}`,
    `Issue date: ${input.issueDate}`,
    input.dueDate
      ? `Due date: ${input.dueDate}${ageDays > 0 ? ` (${ageDays} day(s) past due)` : ""}`
      : `No due date was set; issued ${daysBetween(input.issueDate, input.today)} day(s) ago`,
  ];
  if (input.behaviour) {
    const beyond =
      daysBetween(input.issueDate, input.today) -
      input.behaviour.medianDaysToPay;
    lines.push(
      `This customer's payments usually arrive about ${input.behaviour.medianDaysToPay} day(s) after invoicing (from ${input.behaviour.settledCount} matched payments)${
        beyond > 0 ? `; this invoice is ${beyond} day(s) beyond that` : ""
      }`,
    );
  }
  return lines.join("\n");
}

// The deterministic fallback — always a complete, sendable reminder.
export function templateChaser(input: ChaserFactsInput): {
  subject: string;
  body: string;
} {
  const refDate = input.dueDate ?? input.issueDate;
  const ageDays = daysBetween(refDate, input.today);
  const overdue =
    input.dueDate && ageDays > 0
      ? ` It fell due on ${input.dueDate} (${ageDays} day(s) ago).`
      : input.dueDate
        ? ` It falls due on ${input.dueDate}.`
        : "";
  const rhythm = input.behaviour
    ? ` Your payments usually reach us within about ${input.behaviour.medianDaysToPay} day(s) of invoicing, so this one may simply have slipped through.`
    : "";
  return {
    subject: `Payment reminder: invoice ${input.invoiceNumber}`,
    body:
      `Dear ${input.buyerName},\n\n` +
      `This is a friendly reminder that invoice ${input.invoiceNumber} for ` +
      `${input.currency} ${input.grandTotal}, issued on ${input.issueDate}, is still outstanding.${overdue}${rhythm} ` +
      `We would appreciate payment at your earliest convenience.\n\n` +
      `If payment is already on its way, please disregard this note — and thank you.`,
  };
}

export async function draftPaymentChaser(
  invoiceId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
): Promise<PaymentChaserDraft> {
  const [invoice] = await getDb()
    .select({
      id: invoicesTable.id,
      firmId: invoicesTable.firmId,
      supplierPartyId: invoicesTable.supplierPartyId,
      buyerPartyId: invoicesTable.buyerPartyId,
      invoiceNumber: invoicesTable.invoiceNumber,
      currency: invoicesTable.currency,
      grandTotal: invoicesTable.grandTotal,
      issueDate: invoicesTable.issueDate,
      dueDate: invoicesTable.dueDate,
      status: invoicesTable.status,
      kind: invoicesTable.kind,
      buyerName: partiesTable.legalName,
    })
    .from(invoicesTable)
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  // Same tenancy posture as GET /invoices/:id — firm match plus the SEC-03
  // client narrowing to the supplier party.
  assertSameTenant(principal, invoice.firmId);
  assertClientPartyScope(principal, invoice.supplierPartyId);

  if (
    invoice.kind !== "invoice" ||
    !OUTSTANDING_STATUSES.has(invoice.status)
  ) {
    throw new DomainError(
      "NOT_CHASEABLE",
      "Only an outstanding receivable (issued and not yet settled) can be chased",
      422,
    );
  }
  if (invoice.grandTotal == null) {
    throw new DomainError(
      "NOT_CHASEABLE",
      "This invoice has no total to chase",
      422,
    );
  }

  // Best-effort behaviour hint: a mining failure must never block the letter.
  let behaviour: BuyerPaymentBehaviour | null = null;
  if (invoice.firmId) {
    behaviour = await buyerPaymentBehaviour(
      invoice.firmId,
      invoice.supplierPartyId,
      invoice.buyerPartyId,
    ).catch(() => null);
  }

  const input: ChaserFactsInput = {
    invoiceNumber: invoice.invoiceNumber,
    buyerName: invoice.buyerName,
    currency: invoice.currency,
    grandTotal: String(invoice.grandTotal),
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    today: lagosDateString(),
    behaviour,
  };
  const template = templateChaser(input);
  const fallback: PaymentChaserDraft = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    buyerName: invoice.buyerName,
    subject: template.subject,
    body: template.body,
    source: "template",
  };
  if (!gateway || !(await isFeatureEnabled(CLERK_FLAG_KEY))) return fallback;

  const facts = chaserFacts(input);
  // The try/catch closes the kill-switch TOCTOU: if clerk_ai flips off
  // between the check above and the call, the gateway's own assert throws —
  // and for this surface even that must answer with the template.
  try {
    const result = await gateway.infer<z.infer<typeof chaserOutput>>({
      purpose: "draft_chaser",
      caseId: null,
      // Firm-funded like the other client-facing phrasings. Deliberately NO
      // route budget pre-check: the gateway backstop turns an exhausted
      // allowance into a typed failure, which answers with the template —
      // never a 429.
      firmId: invoice.firmId,
      promptVersion: CHASER_PROMPT_VERSION,
      system: CHASER_SYSTEM,
      user: facts,
      schemaName: "payment_chaser",
      jsonSchema: chaserJsonSchema,
      validator: chaserOutput,
      inputForHash: facts,
    });
    if (!result.ok) return fallback;
    return {
      ...fallback,
      subject: result.data.subject,
      body: result.data.body,
      source: "clerk",
    };
  } catch {
    return fallback;
  }
}
