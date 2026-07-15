import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, b2cReportBatchesTable, b2cReportItemsTable } from "@workspace/db";
import {
  ListB2cReportsQueryParams,
  ListB2cReportsResponse,
  GetB2cReportParams,
  GetB2cReportResponse,
  ListB2cReportItemsParams,
  ListB2cReportItemsResponse,
  SubmitB2cReportParams,
  SubmitB2cReportResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  narrowToClientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { submitBatch } from "../modules/b2c/service";

// B2C reporting surfaces (SME-08), gated by the R2 `b2c_reporting` flag.

const router: IRouter = Router();

router.get("/b2c/reports", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.read");
  const query = ListB2cReportsQueryParams.safeParse(req.query);
  const clientPartyId = narrowToClientPartyScope(
    req.principal,
    query.success ? query.data.clientPartyId : undefined,
  );
  const status = query.success ? query.data.status : undefined;
  const tenant = tenantFirmId(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(b2cReportBatchesTable.firmId, tenant));
  if (clientPartyId)
    conditions.push(eq(b2cReportBatchesTable.clientPartyId, clientPartyId));
  if (status) conditions.push(eq(b2cReportBatchesTable.status, status));
  const rows = await getDb()
    .select()
    .from(b2cReportBatchesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(b2cReportBatchesTable.deadlineAt));
  res.json(ListB2cReportsResponse.parse(rows));
});

async function loadBatchForTenant(
  req: { principal: import("../modules/auth/rbac").Principal },
  id: string,
) {
  const [batch] = await getDb()
    .select()
    .from(b2cReportBatchesTable)
    .where(eq(b2cReportBatchesTable.id, id))
    .limit(1);
  if (!batch) throw new DomainError("NOT_FOUND", "Batch not found", 404);
  assertSameTenant(req.principal, batch.firmId);
  // A client_user only reaches its own client party's batches (SEC-03).
  assertClientPartyScope(req.principal, batch.clientPartyId);
  return batch;
}

router.get("/b2c/reports/:id", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.read");
  const params = parseOrThrow(GetB2cReportParams, req.params);
  const batch = await loadBatchForTenant(req, params.id);
  res.json(GetB2cReportResponse.parse(batch));
});

router.get("/b2c/reports/:id/items", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.read");
  const params = parseOrThrow(ListB2cReportItemsParams, req.params);
  await loadBatchForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(b2cReportItemsTable)
    .where(eq(b2cReportItemsTable.batchId, params.id))
    .orderBy(asc(b2cReportItemsTable.createdAt));
  res.json(ListB2cReportItemsResponse.parse(rows));
});

router.post("/b2c/reports/:id/submit", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.write");
  const params = parseOrThrow(SubmitB2cReportParams, req.params);
  await loadBatchForTenant(req, params.id);
  const updated = await submitBatch(params.id, {
    userId: req.principal.userId,
    role: req.principal.role,
  });
  res.json(SubmitB2cReportResponse.parse(updated));
});

export default router;
