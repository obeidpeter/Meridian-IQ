import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, engagementsTable, partiesTable } from "@workspace/db";
import {
  CreateClientBody,
  CreateClientResponse,
  ExportClientDataParams,
  ExportClientDataResponse,
  OffboardClientBody,
  OffboardClientParams,
  OffboardClientResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
  type Principal,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";
import { createParty, validateTin } from "../modules/party/party";
import { offboardClient } from "../modules/party/offboard";
import { exportClientData } from "../modules/audit/client-export";

// Client data lifecycle (NDPA): create an engaged client, export one client's
// data (data-subject access), and offboard a client firm-scoped. The party
// spine stays shared (CORE-08) — creation goes through createParty
// (provenance + party.create audit), export applies a tenant lens in the
// module, and offboarding archives rather than deletes (statutory retention).

const router: IRouter = Router();

// Destructive lifecycle actions are firm-level administration, pinned to the
// EXPLICIT firm_admin role (the routes/integrations.ts precedent): staff and
// client_users act under a firm's client roster, they do not dissolve it, and
// no capability in the matrix describes "end a client relationship" (adding
// one would hand it to every role holding a broad capability by accident).
// The explicit check also excludes machine principals by construction — an
// API key's synthetic "api_key" role can never offboard a client.
// requireFirmScope then pins the teardown to the caller's own tenant.
function firmAdminScope(principal: Principal): string {
  if (principal.role !== "firm_admin") {
    throw new DomainError(
      "FORBIDDEN",
      "Client offboarding is a firm-admin surface",
      403,
    );
  }
  return requireFirmScope(principal);
}

// Single engaged-client creation: one party (shared spine, with provenance)
// plus the retainer engagement that places the client inside the firm's
// tenant boundary (see assertPartyAccess) — both on the ambient request
// transaction, so they land in a single commit or not at all.
router.post("/clients", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  assertCan(req.principal, "party.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateClientBody, req.body);

  // Duplicate guard, scoped to THIS firm's ENGAGED clients (by normalized
  // TIN, then exact legal name — the clients-import detection order). Parties
  // are shared reference data, so an unscoped lookup would be a cross-tenant
  // oracle: any firm could probe arbitrary TINs and harvest other
  // organizations' rosters (routes/whitelabel.ts precedent). A TIN that
  // exists elsewhere on the platform simply creates a new party here; the
  // operator-driven merge workflow (CORE-08) reconciles duplicates with
  // lineage. Format validation stays inside createParty (single source of
  // truth) — an invalid TIN skips the TIN probe and fails there with 400.
  const tinCheck = parsed.tin ? validateTin(parsed.tin) : null;
  let duplicateId: string | null = null;
  if (tinCheck?.valid) {
    const [byTin] = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .innerJoin(
        engagementsTable,
        and(
          eq(engagementsTable.clientPartyId, partiesTable.id),
          eq(engagementsTable.firmId, firmId),
        ),
      )
      .where(eq(partiesTable.tin, tinCheck.normalized))
      .limit(1);
    duplicateId = byTin?.id ?? null;
  }
  if (!duplicateId) {
    const [byName] = await getDb()
      .select({ id: partiesTable.id })
      .from(partiesTable)
      .innerJoin(
        engagementsTable,
        and(
          eq(engagementsTable.clientPartyId, partiesTable.id),
          eq(engagementsTable.firmId, firmId),
        ),
      )
      .where(eq(partiesTable.legalName, parsed.legalName))
      .limit(1);
    duplicateId = byName?.id ?? null;
  }
  if (duplicateId) {
    throw new DomainError(
      "DUPLICATE_CLIENT",
      "This firm already engages a client with that TIN or legal name",
      409,
    );
  }

  // createParty validates/normalizes TIN+CAC, records provenance from the
  // authenticated principal, and appends the party.create audit event.
  const party = await createParty(
    {
      type: "client_business",
      legalName: parsed.legalName,
      tin: parsed.tin ?? null,
      cacNumber: parsed.cacNumber ?? null,
      street: parsed.street ?? null,
      city: parsed.city ?? null,
    },
    req.principal.userId,
    firmId,
  );

  // The engagement mirrors routes/engagements.ts POST (including its
  // engagement.create audit), with the clients-import defaults: an
  // in_progress retainer titled from the legal name.
  const [engagement] = await getDb()
    .insert(engagementsTable)
    .values({
      firmId,
      clientPartyId: party.id,
      type: "retainer",
      status: "in_progress",
      title: `${parsed.legalName} — compliance retainer`,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "engagement.create",
    entityType: "engagement",
    entityId: engagement.id,
    after: { title: engagement.title, type: engagement.type },
  });

  res.status(201).json(
    CreateClientResponse.parse({
      partyId: party.id,
      engagementId: engagement.id,
      legalName: party.legalName,
    }),
  );
});

// Data-subject export. Access is assertPartyAccess whole: a client_user is
// pinned to its OWN party (SEC-03, CROSS_CLIENT otherwise), a firm principal
// must hold an engagement with the party (the engagement wall — CROSS_TENANT
// otherwise, before any existence disclosure), and cross-tenant read-only
// staff (operator/auditor, the firm-export pair) pass through. The tenant
// lens: firm-scoped callers get their own tenant's slice of the firm-keyed
// sections; the data subject's own client_user and operators/auditors get
// the party's data across ALL engaging firms (null lens) — that is what a
// data-subject access request means.
router.get("/clients/:id/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "party.read");
  const params = parseOrThrow(ExportClientDataParams, req.params);
  await assertPartyAccess(req.principal, params.id);
  const firmLens =
    clientPartyScope(req.principal) !== null
      ? null
      : tenantFirmId(req.principal);
  const bundle = await exportClientData(params.id, firmLens); // 404 when the party does not exist
  // Audit the export itself, pointer-only (section row counts, never
  // content), AFTER assembling the bundle so an export never contains its
  // own event (routes/audit.ts firm-export posture).
  await appendAudit({
    actorId: req.principal.userId,
    actorRole: req.principal.role,
    firmId: firmLens,
    action: "audit.client_export",
    entityType: "party",
    entityId: params.id,
    after: {
      sections: Object.fromEntries(bundle.counts.map((c) => [c.section, c.rows])),
      truncated: bundle.counts.filter((c) => c.truncated).map((c) => c.section),
    },
  });
  res.json(ExportClientDataResponse.parse(bundle));
});

// Firm-scoped offboarding. firm_admin only (see firmAdminScope), pinned to
// the caller's tenant, behind the engagement wall — then the module does the
// teardown: archive engagements, remove access, clear shared contact PII
// only on the last engagement, one pointer-only audit event. Statutory
// identity on the party row is retained (legal-obligation basis).
router.post("/clients/:id/offboard", async (req, res): Promise<void> => {
  const firmId = firmAdminScope(req.principal);
  const params = parseOrThrow(OffboardClientParams, req.params);
  const body = parseOrThrow(OffboardClientBody, req.body);
  await assertPartyAccess(req.principal, params.id);
  const outcome = await offboardClient(
    firmId,
    params.id,
    body.confirmLegalName,
    { userId: req.principal.userId, role: req.principal.role },
  );
  res.json(OffboardClientResponse.parse(outcome));
});

export default router;
