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
  ListStatementFormatsResponse,
  CreateStatementFormatBody,
  CreateStatementFormatResponse,
  DeleteStatementFormatParams,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  assertPartyAccess,
  assertSameTenant,
  narrowToClientPartyScope,
  requireFirmScope,
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
import {
  deleteFormatMapping,
  listFormatMappings,
  saveFormatMapping,
} from "../modules/statements/custom-formats";

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
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(ImportBankStatementBody, req.body);
  if (parsed.csv.length > MAX_STATEMENT_CSV_CHARS) {
    res.status(413).json({
      error: "Statement file is too large to process",
    });
    return;
  }
  await assertPartyAccess(req.principal, parsed.clientPartyId);
  const result = await ingestStatement({
    firmId,
    clientPartyId: parsed.clientPartyId,
    csv: parsed.csv,
    formatKey: parsed.formatKey ?? null,
    filename: parsed.filename ?? null,
    commit: parsed.commit,
    actorId: req.principal.userId,
  });
  res.json(ImportBankStatementResponse.parse(result));
});

router.get("/statements", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.read");
  const query = ListBankStatementsQueryParams.safeParse(req.query);
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.success ? query.data.clientPartyId : undefined,
  );
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
  const params = parseOrThrow(GetBankStatementParams, req.params);
  const statement = await loadStatementForTenant(req, params.id);
  res.json(GetBankStatementResponse.parse(statement));
});

router.get("/statements/:id/lines", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.read");
  const params = parseOrThrow(ListBankStatementLinesParams, req.params);
  await loadStatementForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, params.id))
    .orderBy(asc(bankStatementLinesTable.lineNo));
  res.json(ListBankStatementLinesResponse.parse(rows));
});

router.get("/statements/:id/proposals", requireFlag("reconciliation"), async (req, res): Promise<void> => {
  assertCan(req.principal, "reconciliation.read");
  const params = parseOrThrow(ListBankStatementProposalsParams, req.params);
  await loadStatementForTenant(req, params.id);
  const lines = await getDb()
    .select({
      id: bankStatementLinesTable.id,
      lineNo: bankStatementLinesTable.lineNo,
      valueDate: bankStatementLinesTable.valueDate,
      amount: bankStatementLinesTable.amount,
      narration: bankStatementLinesTable.narration,
    })
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, params.id));
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
      statementId: params.id,
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

// ---- custom statement formats (Clerk idea #9) ----
// Operator-managed platform reference data, like the error catalogue — hence
// catalogue.write. Saving REQUIRES a validation run against the caller's
// sample; a mapping that cannot parse its own sample is rejected (422), so a
// wrong proposal (Clerk's or a human's) can never be stored. NOT behind the
// reconciliation flag: formats are platform config, useful before rollout.

router.get("/statement-formats", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const rows = await listFormatMappings();
  res.json(
    ListStatementFormatsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        key: r.key,
        bankName: r.bankName,
        columns: r.columns,
        createdAt: r.createdAt,
      })),
    ),
  );
});

router.post("/statement-formats", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const parsed = parseOrThrow(CreateStatementFormatBody, req.body);
  const { mapping, validation } = await saveFormatMapping(
    parsed,
    req.principal.userId,
  );
  res.status(201).json(
    CreateStatementFormatResponse.parse({
      mapping: {
        id: mapping.id,
        key: mapping.key,
        bankName: mapping.bankName,
        columns: mapping.columns,
        createdAt: mapping.createdAt,
      },
      validation,
    }),
  );
});

router.delete("/statement-formats/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const params = parseOrThrow(DeleteStatementFormatParams, req.params);
  await deleteFormatMapping(params.id, req.principal.userId);
  res.status(204).end();
});

// ---- reconciliation decisions ----

router.post(
  "/reconciliation/proposals/:id/accept",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const params = parseOrThrow(AcceptMatchProposalParams, req.params);
    // Tenant guard: the proposal row itself carries the firm.
    const [proposal] = await getDb()
      .select({ firmId: matchProposalsTable.firmId })
      .from(matchProposalsTable)
      .where(eq(matchProposalsTable.id, params.id))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertSameTenant(req.principal, proposal.firmId);
    const result = await acceptProposal(params.id, {
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
    const params = parseOrThrow(BulkAcceptMatchProposalsParams, req.params);
    const body = parseOrThrow(BulkAcceptMatchProposalsBody, req.body ?? {});
    const [statement] = await getDb()
      .select({
        firmId: bankStatementsTable.firmId,
        clientPartyId: bankStatementsTable.clientPartyId,
      })
      .from(bankStatementsTable)
      .where(eq(bankStatementsTable.id, params.id))
      .limit(1);
    if (!statement) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    assertSameTenant(req.principal, statement.firmId);
    assertClientPartyScope(req.principal, statement.clientPartyId);
    const result = await bulkAcceptProposals(
      params.id,
      { userId: req.principal.userId, role: req.principal.role },
      body.threshold,
    );
    res.json(BulkAcceptMatchProposalsResponse.parse(result));
  },
);

router.post(
  "/reconciliation/proposals/:id/reject",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const params = parseOrThrow(RejectMatchProposalParams, req.params);
    const [proposal] = await getDb()
      .select({ firmId: matchProposalsTable.firmId })
      .from(matchProposalsTable)
      .where(eq(matchProposalsTable.id, params.id))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertSameTenant(req.principal, proposal.firmId);
    const result = await rejectProposal(params.id, {
      userId: req.principal.userId,
      role: req.principal.role,
    });
    res.json(RejectMatchProposalResponse.parse(result));
  },
);

export default router;
