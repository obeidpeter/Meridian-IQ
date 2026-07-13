import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, engagementsTable } from "@workspace/db";
import {
  ListEngagementsResponse,
  CreateEngagementBody,
  CreateEngagementResponse,
  GetEngagementParams,
  GetEngagementResponse,
  UpdateEngagementParams,
  UpdateEngagementBody,
  UpdateEngagementResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";

const router: IRouter = Router();

router.get("/engagements", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const tenant = tenantFirmId(req.principal);
  // SEC-03: firm-keyed RLS shares the whole firm across its client_users, so a
  // firm-only filter would leak every sibling client's engagements (and their
  // assessment findings) to any one client. Narrow a client_user to its own
  // client party; firm staff and cross-tenant roles are unaffected.
  const scope = clientPartyScope(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(engagementsTable.firmId, tenant));
  if (scope) conditions.push(eq(engagementsTable.clientPartyId, scope));
  const rows = await getDb()
    .select()
    .from(engagementsTable)
    .where(conditions.length ? and(...conditions) : undefined);
  res.json(ListEngagementsResponse.parse(rows));
});

router.post("/engagements", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = CreateEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await getDb()
    .insert(engagementsTable)
    .values({
      firmId,
      clientPartyId: parsed.data.clientPartyId,
      type: parsed.data.type,
      title: parsed.data.title,
      findings: parsed.data.findings ?? null,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "engagement.create",
    entityType: "engagement",
    entityId: row.id,
    after: { title: row.title, type: row.type },
  });
  res.status(201).json(CreateEngagementResponse.parse(row));
});

router.get("/engagements/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }
  assertSameTenant(req.principal, row.firmId);
  // SEC-03: a client_user may only read its own client party's engagement,
  // not a sibling client's within the same firm.
  assertClientPartyScope(req.principal, row.clientPartyId);
  res.json(GetEngagementResponse.parse(row));
});

router.patch("/engagements/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const params = UpdateEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }
  assertSameTenant(req.principal, existing.firmId);
  // SEC-03: keep the sub-tenant guard consistent with the read paths even
  // though engagement.write is a firm-staff capability today.
  assertClientPartyScope(req.principal, existing.clientPartyId);
  const [row] = await getDb()
    .update(engagementsTable)
    .set({
      status: parsed.data.status ?? existing.status,
      title: parsed.data.title ?? existing.title,
      findings: parsed.data.findings ?? existing.findings,
    })
    .where(
      and(
        eq(engagementsTable.id, params.data.id),
        eq(engagementsTable.firmId, existing.firmId),
      ),
    )
    .returning();
  res.json(UpdateEngagementResponse.parse(row));
});

export default router;
