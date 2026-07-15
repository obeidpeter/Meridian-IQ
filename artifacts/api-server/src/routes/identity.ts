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
  CreatePasswordResetBody,
  CreatePasswordResetResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { isUuid } from "../lib/uuid";
import {
  ROLE_CAPABILITIES,
  assertCan,
  assertSameTenant,
  tenantFirmId,
} from "../modules/auth/rbac";
import { createPasswordReset } from "../modules/auth/password-reset";

const router: IRouter = Router();


router.get("/me", async (req, res): Promise<void> => {
  const p = req.principal;
  // Display identity for the signed-in UI. Dev-header principals may carry a
  // userId with no users row — identity stays null rather than failing.
  const [user] = isUuid(p.userId)
    ? await getDb()
        .select({ email: usersTable.email, fullName: usersTable.fullName })
        .from(usersTable)
        .where(eq(usersTable.id, p.userId))
        .limit(1)
    : [];
  res.json(
    GetMeResponse.parse({
      userId: p.userId,
      role: p.role,
      email: user?.email ?? null,
      fullName: user?.fullName ?? null,
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
  const parsed = parseOrThrow(CreateFirmBody, req.body);
  const [row] = await getDb()
    .insert(firmsTable)
    .values({
      name: parsed.name,
      subdomain: parsed.subdomain ?? null,
      partyId: parsed.partyId ?? null,
    })
    .returning();
  res.status(201).json(CreateFirmResponse.parse(row));
});

router.get("/firms/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.read");
  const params = parseOrThrow(GetFirmParams, req.params);
  assertSameTenant(req.principal, params.id);
  const [row] = await getDb()
    .select()
    .from(firmsTable)
    .where(eq(firmsTable.id, params.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  res.json(GetFirmResponse.parse(row));
});

router.post("/users", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = parseOrThrow(CreateUserBody, req.body);
  const [row] = await getDb()
    .insert(usersTable)
    .values({
      email: parsed.email,
      fullName: parsed.fullName ?? null,
      clerkUserId: parsed.clerkUserId ?? null,
    })
    .returning();
  res.status(201).json(CreateUserResponse.parse(row));
});

router.post("/memberships", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = parseOrThrow(CreateMembershipBody, req.body);
  const [row] = await getDb()
    .insert(membershipsTable)
    .values({
      userId: parsed.userId,
      firmId: parsed.firmId ?? null,
      role: parsed.role,
      clientPartyId: parsed.clientPartyId ?? null,
      buyerPartyId: parsed.buyerPartyId ?? null,
    })
    .returning();
  res.status(201).json(CreateMembershipResponse.parse(row));
});

// Operator support path (IDN-02): issue a one-time password-reset link for a
// user who lost access. The raw token is returned once, mirroring invitations.
router.post("/password-resets", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = parseOrThrow(CreatePasswordResetBody, req.body);
  const result = await createPasswordReset(req.principal, parsed.email);
  res.status(201).json(CreatePasswordResetResponse.parse(result));
});

export default router;
