import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  applyTransition,
  isPresentableAsEligible,
  recordTransition,
} from "../invoice/lifecycle.ts";
import { registerHandler, type HandlerOutcome } from "../pipeline/pipeline";
import {
  parseStatementText,
  type ParsedStatement,
} from "./parsers.ts";
import { parseWithCustomFormats } from "./custom-formats.ts";
import {
  proposeMatches,
  type MatchCandidate,
  type MatchableLine,
} from "../reconciliation/matcher.ts";
import { BILL_OF_CLIENT, BILL_UNPAID } from "../invoice/payables.ts";

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
  // Built-in bank parsers first, then the operator-managed custom mappings
  // (custom-formats.ts) — same detect-then-parse contract either way.
  const parsed =
    parseStatementText(input.csv, input.formatKey) ??
    (await parseWithCustomFormats(input.csv, input.formatKey));
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

// Candidate set for matching, two lanes (payables round):
//  - RECEIVABLES (credit lane): the client's own invoices that are stamped or
//    confirmed (still awaiting settlement) and presentable as eligible
//    (CORE-09); the narration counterparty is the BUYER.
//  - BILLS (debit lane): captured supplier invoices where this client is the
//    BUYER (BILL_OF_CLIENT, payables.ts), still unpaid (no payment evidence —
//    bills never transition, so status alone says nothing), any non-cancelled
//    status; the narration counterparty is the SUPPLIER.
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
  const receivables: MatchCandidate[] = rows
    .filter((r) => isPresentableAsEligible(r.status))
    .map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoiceNumber,
      counterpartyName: r.buyerName,
      orientation: "receivable" as const,
      grandTotal: Number(r.grandTotal),
      issueDate: r.issueDate,
      dueDate: r.dueDate,
    }));

  const billRows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      grand_total: string;
      issue_date: string;
      due_date: string | null;
      supplier_name: string;
    }>(sql`
      SELECT i.id, i.invoice_number, i.grand_total::text AS grand_total,
        i.issue_date::text AS issue_date, i.due_date::text AS due_date,
        p.legal_name AS supplier_name
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        AND i.status <> 'cancelled'
        AND ${BILL_UNPAID}
    `)
  ).rows;
  const bills: MatchCandidate[] = billRows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    counterpartyName: r.supplier_name,
    orientation: "bill" as const,
    grandTotal: Number(r.grand_total),
    issueDate: r.issue_date,
    dueDate: r.due_date,
  }));

  return [...receivables, ...bills];
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
// SettlementEvent (source=statement_match, SME-07/CR-01). For a RECEIVABLE
// the invoice also transitions to `settled` with full lineage. For a BILL
// there is NO transition of any kind: bills live and die as drafts (their
// payment state is derived from settlement evidence alone), applyTransition
// would correctly 409 a draft→settled move, and recordTransition would
// fabricate lifecycle lineage for a move that never happened — so the bill
// branch writes the evidence, decides the proposal and audits, nothing more.
export async function acceptProposal(
  proposalId: string,
  actor: { userId: string; role: string },
): Promise<DecisionResult> {
  const { proposal, line, statement } = await loadProposal(proposalId);
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
  // Orientation, resolved exactly as the candidate sets were loaded: a bill
  // proposal is one whose invoice names the statement's client as the BUYER
  // (and not as the supplier — a self-trade counts as a receivable, matching
  // the orientation fragments' precedence).
  const isBill =
    invoice.buyerPartyId === statement.clientPartyId &&
    invoice.supplierPartyId !== statement.clientPartyId;

  let invoiceStatus = invoice.status;
  if (isBill) {
    // CORE-09 mirror for the debit lane: a cancelled bill takes no payment
    // evidence (candidates exclude cancelled; this guards the race).
    if (invoice.status === "cancelled") {
      throw new DomainError(
        "INVOICE_NOT_ELIGIBLE",
        `Invoice is ${invoice.status} and cannot take payment evidence`,
        409,
      );
    }
  } else {
    // CORE-09: a cancelled/credited invoice can never be settled by acceptance.
    if (!isPresentableAsEligible(invoice.status)) {
      throw new DomainError(
        "INVOICE_NOT_ELIGIBLE",
        `Invoice is ${invoice.status} and cannot be settled`,
        409,
      );
    }
    // Compare-and-set FIRST: if a concurrent cancel/credit moved the invoice
    // after the read above, this rejects instead of resurrecting a dead
    // invoice, and no settlement event is written.
    const updated = await applyTransition(
      invoice.id,
      invoice.status,
      "settled",
    );
    invoiceStatus = updated.status;
  }

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
  // Sibling proposals for the same statement line are superseded: one bank
  // line settles (or pays) one invoice.
  await getDb()
    .update(matchProposalsTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(matchProposalsTable.statementLineId, proposal.statementLineId),
        eq(matchProposalsTable.status, "proposed"),
      ),
    );
  if (!isBill) {
    await recordTransition({
      invoiceId: invoice.id,
      firmId: invoice.firmId,
      fromStatus: invoice.status,
      toStatus: "settled",
      actorId: actor.userId,
      actorRole: actor.role,
      reason: `statement_match:${line.id}`,
    });
  }
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
    invoiceStatus,
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

