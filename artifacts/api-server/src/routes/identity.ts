import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, firmsTable, usersTable, membershipsTable } from "@workspace/db";
import {
  GetMeResponse,
  ListFirmsResponse,
  CreateFirmBody,
  CreateFirmResponse,
  GetFirmParams,
  GetFirmResponse,
  CreateUserBody,
  CreateUserResponse,
  CreateMembershipBody,
  CreateMembershipResponse,
} from "@workspace/api-zod";
import {
  ROLE_CAPABILITIES,
  assertCan,
  assertSameTenant,
  tenantFirmId,
} from "../modules/auth/rbac";

const router: IRouter = Router();

router.get("/me", (req, res): void => {
  const p = req.principal;
  res.json(
    GetMeResponse.parse({
      userId: p.userId,
      role: p.role,
      firmId: p.firmId,
      clientPartyId: p.clientPartyId,
      buyerPartyId: p.buyerPartyId,
      capabilities: ROLE_CAPABILITIES[p.role] ?? [],
    }),
  );
});

router.get("/firms", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.read");
  // Cross-tenant staff (operator, auditor) enumerate all firms; a firm-scoped
  // principal only ever sees its own firm.
  const tenant = tenantFirmId(req.principal);
  const rows =
    tenant === null
      ? await getDb().select().from(firmsTable).orderBy(firmsTable.createdAt)
      : await getDb().select().from(firmsTable).where(eq(firmsTable.id, tenant));
  res.json(ListFirmsResponse.parse(rows));
});

router.post("/firms", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = CreateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await getDb()
    .insert(firmsTable)
    .values({
      name: parsed.data.name,
      subdomain: parsed.data.subdomain ?? null,
      partyId: parsed.data.partyId ?? null,
    })
    .returning();
  res.status(201).json(CreateFirmResponse.parse(row));
});

router.get("/firms/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.read");
  const params = GetFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  assertSameTenant(req.principal, params.data.id);
  const [row] = await getDb()
    .select()
    .from(firmsTable)
    .where(eq(firmsTable.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  res.json(GetFirmResponse.parse(row));
});

router.post("/users", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await getDb()
    .insert(usersTable)
    .values({
      email: parsed.data.email,
      fullName: parsed.data.fullName ?? null,
      clerkUserId: parsed.data.clerkUserId ?? null,
    })
    .returning();
  res.status(201).json(CreateUserResponse.parse(row));
});

router.post("/memberships", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = CreateMembershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await getDb()
    .insert(membershipsTable)
    .values({
      userId: parsed.data.userId,
      firmId: parsed.data.firmId ?? null,
      role: parsed.data.role,
      clientPartyId: parsed.data.clientPartyId ?? null,
      buyerPartyId: parsed.data.buyerPartyId ?? null,
    })
    .returning();
  res.status(201).json(CreateMembershipResponse.parse(row));
});

export default router;
