import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, firmsTable, usersTable, membershipsTable } from "@workspace/db";
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
import { ROLE_CAPABILITIES } from "../modules/auth/rbac";

const router: IRouter = Router();

router.get("/me", (req, res): void => {
  const p = req.principal;
  res.json(
    GetMeResponse.parse({
      userId: p.userId,
      role: p.role,
      firmId: p.firmId,
      clientPartyId: p.clientPartyId,
      capabilities: ROLE_CAPABILITIES[p.role] ?? [],
    }),
  );
});

router.get("/firms", async (_req, res): Promise<void> => {
  const rows = await db.select().from(firmsTable).orderBy(firmsTable.createdAt);
  res.json(ListFirmsResponse.parse(rows));
});

router.post("/firms", async (req, res): Promise<void> => {
  const parsed = CreateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
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
  const params = GetFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
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
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
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
  const parsed = CreateMembershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(membershipsTable)
    .values({
      userId: parsed.data.userId,
      firmId: parsed.data.firmId ?? null,
      role: parsed.data.role,
      clientPartyId: parsed.data.clientPartyId ?? null,
    })
    .returning();
  res.status(201).json(CreateMembershipResponse.parse(row));
});

export default router;
