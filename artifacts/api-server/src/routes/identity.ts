import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  membershipsTable,
} from "@workspace/db";
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
import { DomainError } from "../modules/errors";
import { litFeatureKeys } from "../modules/flags/flags";
import { activationReleaseTag } from "../modules/flags/releases";
import { hasConsentDecision } from "../modules/consent/consent";
import { createPasswordReset } from "../modules/auth/password-reset";
import { normalizeEmail } from "../modules/auth/session";

const router: IRouter = Router();


// What the shell calls the workspace: the business (client party) for client
// users, the buyer organisation for buyer users, the firm for firm roles.
// Cross-tenant staff carry no firm, and a dev-header principal may name rows
// that do not exist — both resolve to null and the shell falls back to the
// role label.
async function workspaceNameFor(p: {
  role: string;
  firmId: string | null;
  clientPartyId: string | null;
  buyerPartyId: string | null;
}): Promise<string | null> {
  const partyId =
    p.role === "client_user"
      ? p.clientPartyId
      : p.role === "buyer_user"
        ? p.buyerPartyId
        : null;
  if (partyId && isUuid(partyId)) {
    const [party] = await getDb()
      .select({ legalName: partiesTable.legalName })
      .from(partiesTable)
      .where(eq(partiesTable.id, partyId))
      .limit(1);
    if (party?.legalName) return party.legalName;
  }
  if (p.firmId && isUuid(p.firmId)) {
    const [firm] = await getDb()
      .select({ name: firmsTable.name })
      .from(firmsTable)
      .where(eq(firmsTable.id, p.firmId))
      .limit(1);
    return firm?.name ?? null;
  }
  return null;
}

// CORE-03 first-landing capture (D15): only a client user owns consent
// decisions for a business, so every other role answers null (not
// applicable), and a client scope that names no real party answers false.
export async function consentCapturedFor(p: {
  role: string;
  clientPartyId: string | null;
}): Promise<boolean | null> {
  if (p.role !== "client_user" || !p.clientPartyId) return null;
  if (!isUuid(p.clientPartyId)) return false;
  return hasConsentDecision(p.clientPartyId, 1);
}

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
  const me = {
    userId: p.userId,
    role: p.role,
    email: user?.email ?? null,
    fullName: user?.fullName ?? null,
    firmId: p.firmId,
    clientPartyId: p.clientPartyId,
    buyerPartyId: p.buyerPartyId,
    capabilities: ROLE_CAPABILITIES[p.role] ?? [],
    features: await litFeatureKeys(p.firmId),
  };
  res.json(
    GetMeResponse.parse({
      ...me,
      // The shell's activation badge and workspace chip (PL-02 + the R69
      // shell): both computed here so every app names the same stage and
      // the same workspace without a second round trip.
      releaseTag: activationReleaseTag(me.features),
      workspaceName: await workspaceNameFor(p),
      consentCaptured: await consentCapturedFor(p),
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
    throw new DomainError("NOT_FOUND", "Firm not found", 404);
  }
  res.json(GetFirmResponse.parse(row));
});

router.post("/users", async (req, res): Promise<void> => {
  assertCan(req.principal, "identity.write");
  const parsed = parseOrThrow(CreateUserBody, req.body);
  const [row] = await getDb()
    .insert(usersTable)
    .values({
      // The single-normalizer invariant (modules/auth/session.ts): every auth
      // surface keys off the same canonical email form, or login lookups and
      // throttle counters silently disagree with the stored account.
      email: normalizeEmail(parsed.email),
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
