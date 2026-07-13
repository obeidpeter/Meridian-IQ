import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import {
  ImportBankStatementBody,
  ImportBankStatementResponse,
  ListBankStatementsQueryParams,
  ListBankStatementsResponse,
  GetBankStatementParams,
  GetBankStatementResponse,
  ListBankStatementLinesParams,
  ListBankStatementLinesResponse,
  ListBankStatementProposalsParams,
  ListBankStatementProposalsResponse,
  AcceptMatchProposalParams,
  AcceptMatchProposalResponse,
  RejectMatchProposalParams,
  RejectMatchProposalResponse,
  BulkAcceptMatchProposalsParams,
  BulkAcceptMatchProposalsBody,
  BulkAcceptMatchProposalsResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertClientPartyScope,
  assertPartyAccess,
  assertSameTenant,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import {
  ingestStatement,
  acceptProposal,
  rejectProposal,
} from "../modules/statements/service";
import { bulkAcceptProposals } from "../modules/statements/bulk-accept";

// Bank-statement ingestion and reconciliation v1 (INT-05, SME-07). All surfaces
// are gated by the R2 `reconciliation` flag: unreachable while dark (PL-02).

// Hard cap on an uploaded statement's CSV payload. The reconciliation matcher is
// O(lines × invoices), so an unbounded string (up to the 8mb body limit) is an
// authenticated resource-exhaustion vector; 4 MB of CSV is far beyond any real
// bank export (SEC-M3).
const MAX_STATEMENT_CSV_CHARS = 4_000_000;

const router: IRouter = Router();

router.post("/statements", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = ImportBankStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.csv.length > MAX_STATEMENT_CSV_CHARS) {
    res.status(413).json({
      error: "Statement file is too large to process",
    });
    return;
  }
  await assertPartyAccess(req.principal, parsed.data.clientPartyId);
  const result = await ingestStatement({
    firmId,
    clientPartyId: parsed.data.clientPartyId,
    csv: parsed.data.csv,
    formatKey: parsed.data.formatKey ?? null,
    filename: parsed.data.filename ?? null,
    commit: parsed.data.commit,
    actorId: req.principal.userId,
  });
  res.json(ImportBankStatementResponse.parse(result));
});

router.get("/statements", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.read");
  const query = ListBankStatementsQueryParams.safeParse(req.query);
  let clientPartyId = query.success ? query.data.clientPartyId : undefined;
  // A client_user is confined to its own client party (SEC-03): reject an
  // explicit sibling id and always constrain the list to its own party.
  if (clientPartyId) assertClientPartyScope(req.principal, clientPartyId);
  const scope = clientPartyScope(req.principal);
  if (scope) clientPartyId = scope;
  const tenant = tenantFirmId(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(bankStatementsTable.firmId, tenant));
  if (clientPartyId)
    conditions.push(eq(bankStatementsTable.clientPartyId, clientPartyId));
  const rows = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bankStatementsTable.createdAt));
  res.json(ListBankStatementsResponse.parse(rows));
});

async function loadStatementForTenant(
  req: { principal: import("../modules/auth/rbac").Principal },
  id: string,
) {
  const [statement] = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, id))
    .limit(1);
  if (!statement) throw new DomainError("NOT_FOUND", "Statement not found", 404);
  assertSameTenant(req.principal, statement.firmId);
  // A client_user only reaches its own client party's statements (SEC-03).
  assertClientPartyScope(req.principal, statement.clientPartyId);
  return statement;
}

router.get("/statements/:id", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.read");
  const params = GetBankStatementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const statement = await loadStatementForTenant(req, params.data.id);
  res.json(GetBankStatementResponse.parse(statement));
});

router.get("/statements/:id/lines", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.read");
  const params = ListBankStatementLinesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadStatementForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, params.data.id))
    .orderBy(asc(bankStatementLinesTable.lineNo));
  res.json(ListBankStatementLinesResponse.parse(rows));
});

router.get("/statements/:id/proposals", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "reconciliation.read");
  const params = ListBankStatementProposalsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadStatementForTenant(req, params.data.id);
  const lines = await getDb()
    .select({
      id: bankStatementLinesTable.id,
      lineNo: bankStatementLinesTable.lineNo,
      valueDate: bankStatementLinesTable.valueDate,
      amount: bankStatementLinesTable.amount,
      narration: bankStatementLinesTable.narration,
    })
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, params.data.id));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  if (lines.length === 0) {
    res.json(ListBankStatementProposalsResponse.parse([]));
    return;
  }
  const proposals = await getDb()
    .select({
      id: matchProposalsTable.id,
      statementLineId: matchProposalsTable.statementLineId,
      invoiceId: matchProposalsTable.invoiceId,
      confidence: matchProposalsTable.confidence,
      features: matchProposalsTable.features,
      status: matchProposalsTable.status,
      createdAt: matchProposalsTable.createdAt,
      invoiceNumber: invoicesTable.invoiceNumber,
      invoiceStatus: invoicesTable.status,
      invoiceTotal: invoicesTable.grandTotal,
      buyerName: partiesTable.legalName,
    })
    .from(matchProposalsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, matchProposalsTable.invoiceId))
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(
      inArray(
        matchProposalsTable.statementLineId,
        lines.map((l) => l.id),
      ),
    )
    .orderBy(desc(matchProposalsTable.confidence));
  const view = proposals.map((p) => {
    const line = lineById.get(p.statementLineId);
    return {
      id: p.id,
      statementId: params.data.id,
      statementLineId: p.statementLineId,
      invoiceId: p.invoiceId,
      invoiceNumber: p.invoiceNumber,
      invoiceStatus: p.invoiceStatus,
      invoiceTotal: p.invoiceTotal,
      buyerName: p.buyerName,
      lineNo: line?.lineNo,
      lineAmount: line?.amount ?? null,
      lineDate: line?.valueDate ?? null,
      narration: line?.narration ?? null,
      confidence: p.confidence,
      features: p.features,
      status: p.status,
      createdAt: p.createdAt,
    };
  });
  res.json(ListBankStatementProposalsResponse.parse(view));
});

// ---- reconciliation decisions ----

router.post(
  "/reconciliation/proposals/:id/accept",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const params = AcceptMatchProposalParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    // Tenant guard: the proposal row itself carries the firm.
    const [proposal] = await getDb()
      .select({ firmId: matchProposalsTable.firmId })
      .from(matchProposalsTable)
      .where(eq(matchProposalsTable.id, params.data.id))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertSameTenant(req.principal, proposal.firmId);
    const result = await acceptProposal(params.data.id, {
      userId: req.principal.userId,
      role: req.principal.role,
    });
    res.json(AcceptMatchProposalResponse.parse(result));
  },
);

// Bulk-accept: every pending proposal the matcher scored at/above the
// threshold goes through the SAME acceptProposal path (per-proposal
// settlement event, lifecycle transition and audit row).
router.post(
  "/reconciliation/statements/:id/bulk-accept",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const params = BulkAcceptMatchProposalsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = BulkAcceptMatchProposalsBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const [statement] = await getDb()
      .select({
        firmId: bankStatementsTable.firmId,
        clientPartyId: bankStatementsTable.clientPartyId,
      })
      .from(bankStatementsTable)
      .where(eq(bankStatementsTable.id, params.data.id))
      .limit(1);
    if (!statement) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    assertSameTenant(req.principal, statement.firmId);
    assertClientPartyScope(req.principal, statement.clientPartyId);
    const result = await bulkAcceptProposals(
      params.data.id,
      { userId: req.principal.userId, role: req.principal.role },
      body.data.threshold,
    );
    res.json(BulkAcceptMatchProposalsResponse.parse(result));
  },
);

router.post(
  "/reconciliation/proposals/:id/reject",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const params = RejectMatchProposalParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [proposal] = await getDb()
      .select({ firmId: matchProposalsTable.firmId })
      .from(matchProposalsTable)
      .where(eq(matchProposalsTable.id, params.data.id))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertSameTenant(req.principal, proposal.firmId);
    const result = await rejectProposal(params.data.id, {
      userId: req.principal.userId,
      role: req.principal.role,
    });
    res.json(RejectMatchProposalResponse.parse(result));
  },
);

export default router;
