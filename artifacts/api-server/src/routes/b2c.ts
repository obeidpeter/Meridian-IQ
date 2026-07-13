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
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  clientPartyScope,
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
  let clientPartyId = query.success ? query.data.clientPartyId : undefined;
  const status = query.success ? query.data.status : undefined;
  // A client_user is confined to its own client party (SEC-03): reject an
  // explicit sibling id and always constrain the list to its own party.
  if (clientPartyId) assertClientPartyScope(req.principal, clientPartyId);
  const scope = clientPartyScope(req.principal);
  if (scope) clientPartyId = scope;
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
  const params = GetB2cReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const batch = await loadBatchForTenant(req, params.data.id);
  res.json(GetB2cReportResponse.parse(batch));
});

router.get("/b2c/reports/:id/items", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.read");
  const params = ListB2cReportItemsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadBatchForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(b2cReportItemsTable)
    .where(eq(b2cReportItemsTable.batchId, params.data.id))
    .orderBy(asc(b2cReportItemsTable.createdAt));
  res.json(ListB2cReportItemsResponse.parse(rows));
});

router.post("/b2c/reports/:id/submit", requireFlag("b2c_reporting"), async (req, res): Promise<void> => {
  assertCan(req.principal, "b2c.write");
  const params = SubmitB2cReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadBatchForTenant(req, params.data.id);
  const updated = await submitBatch(params.data.id, {
    userId: req.principal.userId,
    role: req.principal.role,
  });
  res.json(SubmitB2cReportResponse.parse(updated));
});

export default router;
