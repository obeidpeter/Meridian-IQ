import { and, asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
  outboxTable,
  type BankStatement,
  type BankStatementLine,
  type MatchProposal,
  type OutboxEvent,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { appendAudit } from "../audit/audit";
import { isPurposePermitted } from "../consent/consent";
import {
  assertTransition,
  isPresentableAsEligible,
  recordTransition,
} from "../invoice/lifecycle.ts";
import { registerHandler, type HandlerOutcome } from "../pipeline/pipeline";
import {
  parseStatementText,
  type ParsedStatement,
} from "./parsers.ts";
import {
  proposeMatches,
  type MatchCandidate,
  type MatchableLine,
} from "../reconciliation/matcher.ts";

// Bank-statement ingestion and reconciliation v1 (INT-05, SME-07).
//
// Ingestion is validate-then-commit (the bulk-import house pattern): commit
// persists the statement and its lines and enqueues an outbox job; proposal
// generation runs async in the pipeline worker. Accepting a proposal writes the
// source-tagged SettlementEvent and transitions the invoice to `settled`.

const LINE_INSERT_CHUNK = 500;

export interface IngestInput {
  firmId: string;
  clientPartyId: string;
  csv: string;
  formatKey?: string | null;
  filename?: string | null;
  commit: boolean;
  actorId: string;
}

export interface IngestResult {
  statementId: string | null;
  committed: boolean;
  formatKey: string | null;
  accountRef: string | null;
  lineCount: number;
  parsedCount: number;
  parseRate: number;
  rows: {
    lineNo: number;
    parseStatus: "parsed" | "invalid";
    valueDate: string | null;
    amount: string | null;
    direction: "credit" | "debit" | null;
    narration: string | null;
    error: string | null;
  }[];
}

function toRows(parsed: ParsedStatement): IngestResult["rows"] {
  return parsed.lines.map((l) => ({
    lineNo: l.lineNo,
    parseStatus: l.parseStatus,
    valueDate: l.valueDate,
    amount: l.amount,
    direction: l.direction,
    narration: l.narration,
    error: l.parseError,
  }));
}

export async function ingestStatement(input: IngestInput): Promise<IngestResult> {
  // Reconciliation is layer-1 compliance processing (Plan 7.2, CORE-03).
  const permitted = await isPurposePermitted(
    input.clientPartyId,
    "reconciliation",
  );
  if (!permitted) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Client has not granted compliance (layer 1) consent",
      403,
    );
  }
  const parsed = parseStatementText(input.csv, input.formatKey);
  if (!parsed) {
    throw new DomainError(
      input.formatKey ? "UNKNOWN_FORMAT" : "FORMAT_NOT_DETECTED",
      input.formatKey
        ? `No statement parser registered for format "${input.formatKey}"`
        : "Could not detect the bank export format; specify formatKey explicitly",
      422,
    );
  }
  if (parsed.lineCount === 0) {
    throw new DomainError(
      "EMPTY_STATEMENT",
      "The statement contains no data lines",
      422,
    );
  }
  const base: Omit<IngestResult, "statementId" | "committed"> = {
    formatKey: parsed.formatKey,
    accountRef: parsed.accountRef,
    lineCount: parsed.lineCount,
    parsedCount: parsed.parsedCount,
    parseRate:
      Math.round((parsed.parsedCount / parsed.lineCount) * 10000) / 10000,
    rows: toRows(parsed),
  };
  if (!input.commit) {
    return { ...base, statementId: null, committed: false };
  }

  const [statement] = await getDb()
    .insert(bankStatementsTable)
    .values({
      firmId: input.firmId,
      clientPartyId: input.clientPartyId,
      formatKey: parsed.formatKey,
      filename: input.filename ?? null,
      accountRef: parsed.accountRef,
      uploadedByUserId: input.actorId,
      status: "committed",
      lineCount: parsed.lineCount,
      parsedCount: parsed.parsedCount,
    })
    .returning();
  for (let i = 0; i < parsed.lines.length; i += LINE_INSERT_CHUNK) {
    const chunk = parsed.lines.slice(i, i + LINE_INSERT_CHUNK);
    await getDb()
      .insert(bankStatementLinesTable)
      .values(
        chunk.map((l) => ({
          statementId: statement.id,
          lineNo: l.lineNo,
          valueDate: l.valueDate,
          amount: l.amount,
          direction: l.direction,
          narration: l.narration,
          counterpartyRef: l.counterpartyRef,
          parseStatus: l.parseStatus,
          parseError: l.parseError,
          rawLine: l.rawLine,
        })),
      );
  }
  // Transactional outbox (INT-09 pattern): the reconcile job is enqueued in the
  // same transaction as the statement rows.
  await getDb().insert(outboxTable).values({
    aggregateType: "bank_statement",
    aggregateId: statement.id,
    type: "statement.reconcile",
    payload: { statementId: statement.id },
  });
  await appendAudit({
    actorId: input.actorId,
    firmId: input.firmId,
    action: "statement.ingest",
    entityType: "bank_statement",
    entityId: statement.id,
    after: {
      formatKey: parsed.formatKey,
      lineCount: parsed.lineCount,
      parsedCount: parsed.parsedCount,
    },
  });
  return { ...base, statementId: statement.id, committed: true };
}

// Candidate set for matching: the client's own invoices that are stamped or
// confirmed (still awaiting settlement) and presentable as eligible (CORE-09).
async function loadCandidates(
  firmId: string,
  clientPartyId: string,
): Promise<MatchCandidate[]> {
  const rows = await getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      grandTotal: invoicesTable.grandTotal,
      issueDate: invoicesTable.issueDate,
      dueDate: invoicesTable.dueDate,
      status: invoicesTable.status,
      buyerName: partiesTable.legalName,
    })
    .from(invoicesTable)
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientPartyId),
        inArray(invoicesTable.status, ["stamped", "confirmed"]),
      ),
    );
  return rows
    .filter((r) => isPresentableAsEligible(r.status))
    .map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoiceNumber,
      buyerName: r.buyerName,
      grandTotal: Number(r.grandTotal),
      issueDate: r.issueDate,
      dueDate: r.dueDate,
    }));
}

// Outbox handler: generate proposals for a committed statement. Idempotent —
// the unique (statementLineId, invoiceId) constraint makes replays no-ops.
async function handleStatementReconcile(
  event: OutboxEvent,
): Promise<HandlerOutcome> {
  const statementId = String(
    (event.payload as { statementId?: string }).statementId ?? "",
  );
  const [statement] = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, statementId))
    .limit(1);
  if (!statement) {
    return { kind: "dead", error: `Statement ${statementId} missing` };
  }
  const lines = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(
      and(
        eq(bankStatementLinesTable.statementId, statementId),
        eq(bankStatementLinesTable.parseStatus, "parsed"),
      ),
    )
    .orderBy(asc(bankStatementLinesTable.lineNo));
  const candidates = await loadCandidates(
    statement.firmId,
    statement.clientPartyId,
  );
  const matchable: MatchableLine[] = lines.map((l) => ({
    lineId: l.id,
    valueDate: l.valueDate,
    amount: Number(l.amount ?? 0),
    direction: l.direction,
    narration: l.narration,
    counterpartyRef: l.counterpartyRef,
  }));
  const proposals = proposeMatches(matchable, candidates);
  for (const p of proposals) {
    await getDb()
      .insert(matchProposalsTable)
      .values({
        firmId: statement.firmId,
        statementLineId: p.lineId,
        invoiceId: p.invoiceId,
        confidence: p.confidence.toFixed(4),
        features: p.features as unknown as Record<string, unknown>,
        status: "proposed",
      })
      .onConflictDoNothing({
        target: [
          matchProposalsTable.statementLineId,
          matchProposalsTable.invoiceId,
        ],
      });
  }
  await getDb()
    .update(bankStatementsTable)
    .set({ status: "reconciled" })
    .where(eq(bankStatementsTable.id, statementId));
  await appendAudit({
    firmId: statement.firmId,
    action: "statement.reconciled",
    entityType: "bank_statement",
    entityId: statementId,
    after: { proposals: proposals.length, candidates: candidates.length },
  });
  return { kind: "done" };
}

registerHandler("statement.reconcile", handleStatementReconcile);

export interface DecisionResult {
  proposalId: string;
  status: "accepted" | "rejected";
  invoiceId: string;
  invoiceStatus: string;
  settlementEventId: string | null;
}

async function loadProposal(
  proposalId: string,
): Promise<{ proposal: MatchProposal; line: BankStatementLine; statement: BankStatement }> {
  const [proposal] = await getDb()
    .select()
    .from(matchProposalsTable)
    .where(eq(matchProposalsTable.id, proposalId))
    .limit(1);
  if (!proposal) throw new DomainError("NOT_FOUND", "Proposal not found", 404);
  const [line] = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.id, proposal.statementLineId))
    .limit(1);
  const [statement] = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, line.statementId))
    .limit(1);
  return { proposal, line, statement };
}

// Accept a proposal: the accepted match is recorded once, as a source-tagged
// SettlementEvent (source=statement_match, SME-07/CR-01), and the invoice
// transitions to `settled` with full lineage.
export async function acceptProposal(
  proposalId: string,
  actor: { userId: string; role: string },
): Promise<DecisionResult> {
  const { proposal, line } = await loadProposal(proposalId);
  if (proposal.status !== "proposed") {
    throw new DomainError(
      "PROPOSAL_DECIDED",
      `Proposal is already ${proposal.status}`,
      409,
    );
  }
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, proposal.invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  // CORE-09: a cancelled/credited invoice can never be settled by acceptance.
  if (!isPresentableAsEligible(invoice.status)) {
    throw new DomainError(
      "INVOICE_NOT_ELIGIBLE",
      `Invoice is ${invoice.status} and cannot be settled`,
      409,
    );
  }
  assertTransition(invoice.status, "settled");

  const occurredAt = line.valueDate
    ? new Date(`${line.valueDate}T00:00:00Z`)
    : new Date();
  const [settlement] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: invoice.id,
      source: "statement_match",
      amount: line.amount ?? invoice.grandTotal,
      confidence: proposal.confidence,
      statementLineId: line.id,
      actorId: actor.userId,
      occurredAt,
    })
    .returning();
  await getDb()
    .update(matchProposalsTable)
    .set({
      status: "accepted",
      decidedByUserId: actor.userId,
      decidedAt: new Date(),
    })
    .where(eq(matchProposalsTable.id, proposal.id));
  // Sibling proposals for the same statement line are superseded: one credit
  // settles one invoice.
  await getDb()
    .update(matchProposalsTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(matchProposalsTable.statementLineId, proposal.statementLineId),
        eq(matchProposalsTable.status, "proposed"),
      ),
    );
  const [updated] = await getDb()
    .update(invoicesTable)
    .set({ status: "settled" })
    .where(eq(invoicesTable.id, invoice.id))
    .returning();
  await recordTransition({
    invoiceId: invoice.id,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: "settled",
    actorId: actor.userId,
    actorRole: actor.role,
    reason: `statement_match:${line.id}`,
  });
  await appendAudit({
    actorId: actor.userId,
    firmId: invoice.firmId,
    action: "reconciliation.accept",
    entityType: "match_proposal",
    entityId: proposal.id,
    after: {
      invoiceId: invoice.id,
      settlementEventId: settlement.id,
      confidence: proposal.confidence,
    },
  });
  return {
    proposalId: proposal.id,
    status: "accepted",
    invoiceId: invoice.id,
    invoiceStatus: updated.status,
    settlementEventId: settlement.id,
  };
}

export async function rejectProposal(
  proposalId: string,
  actor: { userId: string; role: string },
): Promise<DecisionResult> {
  const { proposal } = await loadProposal(proposalId);
  if (proposal.status !== "proposed") {
    throw new DomainError(
      "PROPOSAL_DECIDED",
      `Proposal is already ${proposal.status}`,
      409,
    );
  }
  await getDb()
    .update(matchProposalsTable)
    .set({
      status: "rejected",
      decidedByUserId: actor.userId,
      decidedAt: new Date(),
    })
    .where(eq(matchProposalsTable.id, proposal.id));
  const [invoice] = await getDb()
    .select({ id: invoicesTable.id, status: invoicesTable.status, firmId: invoicesTable.firmId })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, proposal.invoiceId))
    .limit(1);
  await appendAudit({
    actorId: actor.userId,
    firmId: proposal.firmId,
    action: "reconciliation.reject",
    entityType: "match_proposal",
    entityId: proposal.id,
    after: { invoiceId: proposal.invoiceId },
  });
  return {
    proposalId: proposal.id,
    status: "rejected",
    invoiceId: proposal.invoiceId,
    invoiceStatus: invoice?.status ?? "unknown",
    settlementEventId: null,
  };
}

