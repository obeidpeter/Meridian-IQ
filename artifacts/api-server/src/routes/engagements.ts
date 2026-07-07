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
import { assertCan, assertSameTenant, tenantFirmId } from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";

const router: IRouter = Router();

router.get("/engagements", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const tenant = tenantFirmId(req.principal);
  const rows = tenant
    ? await getDb()
        .select()
        .from(engagementsTable)
        .where(eq(engagementsTable.firmId, tenant))
    : await getDb().select().from(engagementsTable);
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
