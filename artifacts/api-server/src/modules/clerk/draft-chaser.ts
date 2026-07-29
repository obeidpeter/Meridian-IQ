import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb, invoicesTable, partiesTable } from "@workspace/db";
import { DomainError } from "../errors";
import { ensureGrounded } from "./grounding";
import {
  assertClientPartyScope,
  assertSameTenant,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";
import { lagosDateString } from "../../lib/lagos-time";
import {
  buyerPaymentBehaviour,
  type BuyerPaymentBehaviour,
} from "../invoice/payment-behaviour";
import { chaseHistory } from "../invoice/chase-log";
import { inferPhrasing, type ClerkGateway } from "./gateway";
import { OUTSTANDING_STATUSES } from "../invoice/receivables";

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

// v2 (round-14 idea #3): the chase ladder. The facts now carry which
// reminder number this is; tone escalates with the stage but NEVER into
// threats — the ceiling is a direct request for a payment date.
// v3: the stage-1 fact carries its digit for number grounding.
const CHASER_PROMPT_VERSION = "chaser.v3";
const CHASER_SYSTEM = [
  "You write a short, polite payment reminder from a Nigerian small business to one of its customers.",
  "Use ONLY the facts provided. Never add, change or estimate an amount, date, invoice number, bank detail or payment method that is not in them.",
  "Never threaten, never mention interest, penalties or legal action.",
  "The facts say which reminder number this is. For the first, be warm and light. For the second, be politely firm and reference the earlier reminder. For the third onward, be direct: note the previous reminders and ask them to confirm a payment date — still courteous, never threatening.",
  "If the facts include the customer's usual payment timing, you may reference it gently.",
  "End by asking them to disregard the note if payment is already on its way.",
  "Tone: professional, direct. 3 to 6 sentences. No placeholders.",
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
  // Ladder position (round-14 idea #3): the reminder number this draft IS
  // (logged reminders + 1) and what came before it.
  stage: number;
  previousReminders: { count: number; lastAt: string | null };
}

// The receivables definition — DERIVED from receivables.ts's shared status
// list, so the chaser's eligibility can never drift from what the
// receivables card counts.
const CHASEABLE = new Set<string>(OUTSTANDING_STATUSES);

export interface ChaserFactsInput {
  invoiceNumber: string;
  buyerName: string;
  currency: string;
  grandTotal: string;
  issueDate: string;
  dueDate: string | null;
  today: string;
  behaviour: BuyerPaymentBehaviour | null;
  // The ladder position: 1-based reminder number this draft is, plus when
  // the previous logged reminder went out (null when none).
  stage: number;
  lastReminderAt: string | null;
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
  lines.push(
    input.stage <= 1
      ? // "(reminder number 1)" keeps the digit in the fact text so a model
        // writing "1st reminder" stays number-grounded (grounding.ts) —
        // stage 1 was the most likely over-trigger otherwise.
        `This is the first reminder for this invoice (reminder number 1)`
      : `This is reminder number ${input.stage} for this invoice${
          input.lastReminderAt
            ? `; the previous reminder was sent on ${input.lastReminderAt.slice(0, 10)}`
            : ""
        }`,
  );
  return lines.join("\n");
}

// The deterministic fallback — always a complete, sendable reminder, with
// the ladder stage deciding the register (never the content of any threat:
// the ceiling is asking for a payment date).
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
  const disregard = `\n\nIf payment is already on its way, please disregard this note — and thank you.`;
  if (input.stage <= 1) {
    return {
      subject: `Payment reminder: invoice ${input.invoiceNumber}`,
      body:
        `Dear ${input.buyerName},\n\n` +
        `This is a friendly reminder that invoice ${input.invoiceNumber} for ` +
        `${input.currency} ${input.grandTotal}, issued on ${input.issueDate}, is still outstanding.${overdue}${rhythm} ` +
        `We would appreciate payment at your earliest convenience.` +
        disregard,
    };
  }
  const previously = input.lastReminderAt
    ? ` following our reminder of ${input.lastReminderAt.slice(0, 10)}`
    : ` following our earlier reminder`;
  if (input.stage === 2) {
    return {
      subject: `Second reminder: invoice ${input.invoiceNumber}`,
      body:
        `Dear ${input.buyerName},\n\n` +
        `We are writing again${previously}: invoice ${input.invoiceNumber} for ` +
        `${input.currency} ${input.grandTotal}, issued on ${input.issueDate}, remains outstanding.${overdue} ` +
        `We would be grateful if you could arrange payment, or let us know when to expect it.` +
        disregard,
    };
  }
  return {
    subject: `Follow-up: invoice ${input.invoiceNumber} remains unpaid`,
    body:
      `Dear ${input.buyerName},\n\n` +
      `Despite our previous reminders${input.lastReminderAt ? ` (most recently on ${input.lastReminderAt.slice(0, 10)})` : ""}, invoice ${input.invoiceNumber} for ` +
      `${input.currency} ${input.grandTotal}, issued on ${input.issueDate}, is still unpaid.${overdue} ` +
      `Please confirm a date by which we can expect payment, or contact us if something is holding it up.` +
      disregard,
  };
}

// The staged half of a chaser draft: everything that touches the DATABASE
// (invoice + party join, tenancy asserts, chaseability gates, behaviour and
// ladder reads) plus the always-complete template fallback — and nothing
// that touches the model. Split from the phrasing half (round-22 review
// M3) so a batch caller can close its per-target transaction BEFORE the
// provider is touched; the single route composes the two immediately via
// draftPaymentChaser below.
export interface StagedChaser {
  input: ChaserFactsInput;
  fallback: PaymentChaserDraft;
  // Funded by the CALLER's firm (explainer parity): firm/client principals
  // bill their own allowance; an operator's chaser is platform-funded, not
  // drawn from the firm. Computed once here and used for both the infer
  // and the grounding audit.
  fundingFirmId: string | null;
}

export async function stagePaymentChaser(
  invoiceId: string,
  principal: Principal,
): Promise<StagedChaser> {
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
    !CHASEABLE.has(invoice.status)
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
  // Ladder position (round-14 idea #3): a history-read failure degrades to
  // a first reminder rather than blocking the letter.
  const history = await chaseHistory(invoiceId).catch(() => ({
    invoiceId,
    count: 0,
    lastAt: null,
  }));
  const stage = history.count + 1;

  const input: ChaserFactsInput = {
    invoiceNumber: invoice.invoiceNumber,
    buyerName: invoice.buyerName,
    currency: invoice.currency,
    grandTotal: String(invoice.grandTotal),
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    today: lagosDateString(),
    behaviour,
    stage,
    lastReminderAt: history.lastAt,
  };
  const template = templateChaser(input);
  const fallback: PaymentChaserDraft = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    buyerName: invoice.buyerName,
    subject: template.subject,
    body: template.body,
    source: "template",
    stage,
    previousReminders: { count: history.count, lastAt: history.lastAt },
  };
  return { input, fallback, fundingFirmId: tenantFirmId(principal) };
}

// The phrasing half: one model completion under the digest posture, safe to
// run OUTSIDE any transaction (the inference ledger and the grounding audit
// land on the raw pool when no context is active). Deliberately NO route
// budget pre-check: the gateway backstop turns an exhausted allowance into
// a typed failure, which answers with the template — never a 429. The
// kill-switch check and its TOCTOU catch live in inferPhrasing; the outer
// try keeps the surface's stronger guarantee that even a grounding-check
// failure answers with the template.
export async function phrasePaymentChaser(
  staged: StagedChaser,
  gateway: ClerkGateway | null,
): Promise<PaymentChaserDraft> {
  const facts = chaserFacts(staged.input);
  try {
    const data = await inferPhrasing<z.infer<typeof chaserOutput>>(gateway, {
      purpose: "draft_chaser",
      caseId: null,
      firmId: staged.fundingFirmId,
      promptVersion: CHASER_PROMPT_VERSION,
      system: CHASER_SYSTEM,
      user: facts,
      schemaName: "payment_chaser",
      jsonSchema: chaserJsonSchema,
      validator: chaserOutput,
      inputForHash: facts,
    });
    // Number grounding: a numeral the facts never stated → template answers
    // (grounding.ts). Subject and body are checked together.
    if (
      !data ||
      !(await ensureGrounded(
        "chaser",
        staged.fundingFirmId,
        `${data.subject}\n${data.body}`,
        facts,
      ))
    ) {
      return staged.fallback;
    }
    return {
      ...staged.fallback,
      subject: data.subject,
      body: data.body,
      source: "clerk",
    };
  } catch {
    return staged.fallback;
  }
}

// The single-draft composition the route and tests call — behaviorally
// identical to the pre-split function.
export async function draftPaymentChaser(
  invoiceId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
): Promise<PaymentChaserDraft> {
  return phrasePaymentChaser(
    await stagePaymentChaser(invoiceId, principal),
    gateway,
  );
}

// The chaser surface's phrasing seam, one object — the phrasing eval
// (modules/clerk/phrasing-eval.ts) runs candidate prompts and fixtures
// through EXACTLY what production uses (the DIGEST_PHRASING shape).
export const CHASER_PHRASING = {
  surface: "chaser" as const,
  promptVersion: CHASER_PROMPT_VERSION,
  system: CHASER_SYSTEM,
  schemaName: "payment_chaser",
  jsonSchema: chaserJsonSchema,
  validator: chaserOutput,
  buildUser: (facts: ChaserFactsInput): string => chaserFacts(facts),
  joinOutput: (data: { subject: string; body: string }): string =>
    `${data.subject}\n${data.body}`,
};
