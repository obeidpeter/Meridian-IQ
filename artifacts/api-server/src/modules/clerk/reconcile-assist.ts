import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  bankStatementLinesTable,
  bankStatementsTable,
  matchProposalsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import {
  assertClientPartyScope,
  assertSameTenant,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";
import { isFeatureEnabled } from "../flags/flags";
import { assertFirmClerkBudget } from "./budget";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { fenceUntrusted } from "./prompts";

// Reconciliation match assist (Clerk idea #2). The matcher's middle band —
// proposals below the bulk-accept threshold — is where humans decide cold
// today. This endpoint explains ONE statement line's candidate set: the
// ranking and every highlight are computed HERE from the matcher's own
// recorded features (numbers never come from the model); Clerk only phrases
// the comparison, and when it can't (kill switch, budget, invalid output, no
// provider) the deterministic template text is returned instead. Accepting or
// rejecting stays exactly the existing human decision path — this endpoint
// changes nothing.

const MATCH_ASSIST_PROMPT_VERSION = "match-assist.v1";

const MATCH_ASSIST_SYSTEM = [
  "You explain why a reconciliation matcher ranked candidate invoices for one bank-statement credit, for a Nigerian small-business user deciding which match to accept.",
  "Use ONLY the facts and highlights provided. Never add, change or estimate an amount, date, percentage or invoice number that is not in them.",
  "Never tell the user which candidate to accept — describe the evidence; the decision is theirs.",
  "Write 2-3 plain sentences: why the leading candidate scores highest, and what separates it from the runner-up when one exists.",
  'Return JSON: {"explanation": string}.',
].join("\n");

const assistOutput = z.object({
  explanation: z.string().min(1).max(700),
});

const ASSIST_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { explanation: { type: "string" } },
  required: ["explanation"],
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankedCandidate {
  proposalId: string;
  invoiceId: string;
  invoiceNumber: string;
  confidence: string;
  highlights: string[];
}

export interface MatchAssist {
  statementLineId: string;
  explanation: string;
  source: "clerk" | "template";
  ranked: RankedCandidate[];
}

// The matcher records its per-feature evidence on every proposal
// (matcher.ts scorePair); these are the plain-language readings of those
// scores. Pure and exported so the phrasing is unit-testable.
export function proposalHighlights(input: {
  features: Record<string, unknown> | null;
  valueDate: string | null;
  issueDate: string;
}): string[] {
  const f = input.features ?? {};
  const amount = Number(f.amountScore ?? 0);
  const reference = Number(f.referenceScore ?? 0);
  const name = Number(f.nameScore ?? 0);
  const highlights: string[] = [];

  if (amount >= 1) {
    highlights.push("the paid amount matches the invoice total exactly");
  } else if (amount >= 0.7) {
    highlights.push(
      "the paid amount is within 2% of the invoice total (transfer fees commonly explain the gap)",
    );
  } else if (amount > 0) {
    highlights.push("the paid amount is within 5% of the invoice total");
  }

  if (reference >= 1) {
    highlights.push("the invoice number appears in the bank narration");
  }

  // The date highlight is gated on the matcher's RECORDED score, not a
  // recomputation: a payment the matcher scored 0 for (implausibly early, or
  // outside the 60-day window) gets no date "evidence" here — this module
  // must never claim support the matcher withheld.
  const date = Number(f.dateScore ?? 0);
  if (date > 0 && input.valueDate) {
    const days = Math.round(
      (Date.parse(input.valueDate) - Date.parse(input.issueDate)) / DAY_MS,
    );
    if (Number.isFinite(days)) {
      if (days <= 0) {
        highlights.push("payment landed on or just before the issue date");
      } else {
        highlights.push(
          `payment landed ${days} day${days === 1 ? "" : "s"} after the invoice was issued`,
        );
      }
    }
  }

  if (name >= 0.99) {
    highlights.push("the customer's name appears in the narration");
  } else if (name >= 0.5) {
    highlights.push("most of the customer's name appears in the narration");
  } else if (name > 0) {
    highlights.push("part of the customer's name appears in the narration");
  }

  return highlights;
}

function pct(confidence: string): string {
  return `${Math.round(Number(confidence) * 100)}%`;
}

// The deterministic fallback narrative — also the grounding shown to the
// model (digest posture). Pure so it is unit-testable.
export function buildTemplateAssist(ranked: RankedCandidate[]): string {
  const top = ranked[0];
  const lead = `${top.invoiceNumber} is the strongest candidate at ${pct(top.confidence)}: ${
    top.highlights.length > 0
      ? top.highlights.join("; ")
      : "the amounts agree"
  }.`;
  const runnerUp = ranked[1];
  const contrast = runnerUp
    ? ` ${runnerUp.invoiceNumber} scores ${pct(runnerUp.confidence)}: ${
        runnerUp.highlights.length > 0
          ? runnerUp.highlights.join("; ")
          : "the amounts agree, with weaker supporting evidence"
      }.`
    : "";
  return `${lead}${contrast} The decision stays with you.`;
}

// Explain one statement line's pending candidates. `gateway` may be null (no
// provider configured) — the template path always answers.
export async function assistMatch(
  statementLineId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
): Promise<MatchAssist> {
  const [line] = await getDb()
    .select({
      id: bankStatementLinesTable.id,
      statementId: bankStatementLinesTable.statementId,
      valueDate: bankStatementLinesTable.valueDate,
      amount: bankStatementLinesTable.amount,
      narration: bankStatementLinesTable.narration,
    })
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.id, statementLineId))
    .limit(1);
  if (!line) {
    throw new DomainError("NOT_FOUND", "Statement line not found", 404);
  }
  const [statement] = await getDb()
    .select({
      firmId: bankStatementsTable.firmId,
      clientPartyId: bankStatementsTable.clientPartyId,
    })
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, line.statementId))
    .limit(1);
  if (!statement) {
    throw new DomainError("NOT_FOUND", "Statement not found", 404);
  }
  // Same tenancy posture as the statements routes: firm match plus the SEC-03
  // client narrowing to the statement's own client party.
  assertSameTenant(principal, statement.firmId);
  assertClientPartyScope(principal, statement.clientPartyId);

  const proposals = await getDb()
    .select({
      proposalId: matchProposalsTable.id,
      invoiceId: matchProposalsTable.invoiceId,
      confidence: matchProposalsTable.confidence,
      features: matchProposalsTable.features,
      invoiceNumber: invoicesTable.invoiceNumber,
      invoiceTotal: invoicesTable.grandTotal,
      issueDate: invoicesTable.issueDate,
      buyerName: partiesTable.legalName,
    })
    .from(matchProposalsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, matchProposalsTable.invoiceId))
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(
      and(
        eq(matchProposalsTable.statementLineId, statementLineId),
        eq(matchProposalsTable.status, "proposed"),
      ),
    )
    .orderBy(desc(matchProposalsTable.confidence));
  if (proposals.length === 0) {
    throw new DomainError(
      "NO_PROPOSALS",
      "This statement line has no pending match proposals to explain",
      404,
    );
  }

  const ranked: RankedCandidate[] = proposals.map((p) => ({
    proposalId: p.proposalId,
    invoiceId: p.invoiceId,
    invoiceNumber: p.invoiceNumber,
    confidence: p.confidence,
    highlights: proposalHighlights({
      features: p.features,
      valueDate: line.valueDate,
      issueDate: p.issueDate,
    }),
  }));
  const template: MatchAssist = {
    statementLineId,
    explanation: buildTemplateAssist(ranked),
    source: "template",
    ranked,
  };

  // Clerk phrasing is best-effort: no provider, kill switch off or budget
  // spent → the grounded template text is the answer, not an error.
  if (!gateway) return template;
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return template;
  const tenant = tenantFirmId(principal);
  if (tenant) {
    try {
      await assertFirmClerkBudget(tenant);
    } catch {
      return template;
    }
  }

  const candidateFacts = proposals.map((p, i) => {
    const r = ranked[i];
    return [
      `Candidate ${i + 1}: invoice ${p.invoiceNumber} to ${p.buyerName}`,
      `- match confidence: ${pct(p.confidence)}`,
      `- invoice total: NGN ${p.invoiceTotal}, issued ${p.issueDate}`,
      `- highlights: ${r.highlights.length > 0 ? r.highlights.join("; ") : "(amount agreement only)"}`,
    ].join("\n");
  });
  const user = [
    `Bank credit: NGN ${line.amount ?? "?"} on ${line.valueDate ?? "(no date)"}`,
    fenceUntrusted("bank narration", "NARRATION", line.narration ?? "(none)"),
    "",
    // Invoice numbers and buyer names are client-authored data; the facts
    // block travels fenced like the narration so nothing user-influenced can
    // steer the phrasing outside its data role.
    fenceUntrusted(
      "candidate invoice facts",
      "CANDIDATES",
      candidateFacts.join("\n\n"),
    ),
  ].join("\n");

  const result = await gateway.infer<z.infer<typeof assistOutput>>({
    purpose: "explain_match",
    firmId: tenant,
    promptVersion: MATCH_ASSIST_PROMPT_VERSION,
    system: MATCH_ASSIST_SYSTEM,
    user,
    schemaName: "match_assist",
    jsonSchema: ASSIST_JSON_SCHEMA,
    validator: assistOutput,
    inputForHash: `${statementLineId}:${ranked.map((r) => `${r.proposalId}=${r.confidence}`).join(",")}`,
  });
  if (!result.ok) return template;
  return { ...template, explanation: result.data.explanation, source: "clerk" };
}
