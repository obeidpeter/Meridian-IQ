import { and, eq, ne } from "drizzle-orm";
import {
  db as baseDb,
  getDb,
  alertPreferencesTable,
  engagementsTable,
  invitationsTable,
  membershipsTable,
  partyNameAliasesTable,
  pushDevicesTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { getParty } from "./party";

// Firm-scoped client offboarding (NDPA data lifecycle, POST
// /clients/{id}/offboard).
//
// Parties are the SHARED SPINE — no tenant key, no RLS, and one party may be
// engaged by SEVERAL firms — so offboarding is a FIRM-SCOPED teardown, never
// a party deletion. The party row's statutory identity (legal_name, tin,
// cac_number) is NEVER deleted or blanked: stamped invoices reference it and
// it is retained under the legal-obligation basis (FIRS record-keeping), the
// same retention wall that makes invoice rows immutable. What a firm's
// offboard removes is exactly that firm's relationship surface:
//
//  (a) its engagements for the party -> status 'archived' (the enum value the
//      unbilled-income and client-statement consumers already honour; an
//      archived engagement still exists, which keeps assertPartyAccess /
//      firmEngagesParty working for retention-era reads);
//  (b) its client_user memberships for the party -> deleted (access removal);
//  (c) its party_name_aliases rows -> deleted unconditionally (aliases pair
//      THIS firm's document vocabulary with the party — firm-keyed data);
//  (d) its pending invitations for the party -> revoked (compare-and-set on
//      status, mirroring the invitation revoke route);
//  (e) the LAST-ENGAGEMENT rule: alert_preferences (contact PII:
//      whatsappTo/phone/email, the contactSetByRole routing gate, and the
//      channel toggles) and push_devices are PARTY-keyed and shared across
//      engaging firms, so they are cleared ONLY when no OTHER firm still
//      holds a non-archived engagement for the party. While another firm
//      still serves the client, its alert rails keep working untouched.
//
// Consent is CLIENT-owned (CORE-03): a firm cannot revoke the client's
// consent, so consent_records are never touched here.
//
// Transaction posture: every write above runs on the ambient request
// transaction (getDb()) — one commit, and the tenantContext 4xx rollback rule
// unwinds everything on failure. The ONE read that cannot run there is the
// last-engagement probe: engagements are firm-keyed RLS, so in a firm
// principal's request context sibling firms' engagements are invisible and
// the probe would always answer "last". It therefore reads on the base
// client, existence-only. That single cross-tenant bit (does anyone else
// still engage this party?) is exactly what the contract returns to the
// caller as `lastEngagement` — no tenant-identifiable data crosses.
// This firm's own just-archived rows are excluded by firm_id, so the base
// read's inability to see the uncommitted archive cannot skew the answer.
//
// Production RLS nuance on (e): push_devices RLS is firm-keyed, so a firm
// principal's DELETE reaches the rows snapshotted under ITS tenant; a device
// row registered under a sibling (now archived) firm's scope survives the
// request context. That residue is inert: the same clearing pass turns every
// alert_preferences channel toggle off, and alert fan-out resolves the
// party's channels through that shared row before any device is contacted —
// with pushEnabled=false the surviving tokens are never used, and the
// bypass-context push-receipt sweep prunes dead tokens over time.

export interface OffboardClientActor {
  userId: string;
  role: string;
}

export interface OffboardClientOutcome {
  engagementsArchived: number;
  membershipsRemoved: number;
  aliasesDeleted: number;
  contactCleared: boolean;
  lastEngagement: boolean;
}

export async function offboardClient(
  firmId: string,
  partyId: string,
  confirmLegalName: string,
  actor: OffboardClientActor,
): Promise<OffboardClientOutcome> {
  const party = await getParty(partyId);
  if (!party) throw new DomainError("NOT_FOUND", "Client party not found", 404);

  // Destructive-action guard: the caller must retype the party's legal name
  // EXACTLY. No trimming or case-folding — a near-miss is a wrong client.
  if (confirmLegalName !== party.legalName) {
    throw new DomainError(
      "CONFIRM_MISMATCH",
      "confirmLegalName does not match the client's legal name",
      400,
    );
  }

  // (a) Archive THIS firm's live engagements for the party. Folding the
  // "non-archived" precondition into the UPDATE makes a repeat offboard (or a
  // concurrent double-submit) lose cleanly with 409 instead of re-running the
  // teardown: zero rows archived means this firm has nothing to offboard.
  const archived = await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, partyId),
        ne(engagementsTable.status, "archived"),
      ),
    )
    .returning({ id: engagementsTable.id });
  if (archived.length === 0) {
    throw new DomainError(
      "NOT_ENGAGED",
      "This firm holds no active engagement for the client",
      409,
    );
  }

  // (b) Remove the party's client_user access under THIS firm. Only
  // client_user rows: staff memberships are not client-scoped, and the
  // role filter keeps a mis-keyed row from widening the delete.
  const removedMemberships = await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, firmId),
        eq(membershipsTable.clientPartyId, partyId),
        eq(membershipsTable.role, "client_user"),
      ),
    )
    .returning({ id: membershipsTable.id });

  // (c) This firm's alias vocabulary for the party — firm-keyed, so deleted
  // unconditionally (no last-engagement rule).
  const deletedAliases = await getDb()
    .delete(partyNameAliasesTable)
    .where(
      and(
        eq(partyNameAliasesTable.firmId, firmId),
        eq(partyNameAliasesTable.partyId, partyId),
      ),
    )
    .returning({ id: partyNameAliasesTable.id });

  // (d) Revoke this firm's still-pending invitations for the party
  // (compare-and-set on status, the revoke route's mechanics) so an unused
  // invite link cannot re-open access after offboarding.
  const revokedInvitations = await getDb()
    .update(invitationsTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(invitationsTable.firmId, firmId),
        eq(invitationsTable.clientPartyId, partyId),
        eq(invitationsTable.status, "pending"),
      ),
    )
    .returning({ id: invitationsTable.id });

  // (e) Last-engagement probe — see the module header for why this single
  // existence read runs on the base client rather than the request tx.
  const [otherFirmEngagement] = await baseDb
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.clientPartyId, partyId),
        ne(engagementsTable.firmId, firmId),
        ne(engagementsTable.status, "archived"),
      ),
    )
    .limit(1);
  const lastEngagement = !otherFirmEngagement;

  let contactCleared = false;
  let clearedPreferences = 0;
  let removedDevices = 0;
  if (lastEngagement) {
    // Contact PII off, provenance gate off (a null contactSetByRole means the
    // inbound WhatsApp rail fails closed for this number), channels dark. The
    // alert-TYPE toggles (deadline/failure/penalty) are preferences, not PII,
    // and are left as-is for a possible future re-engagement.
    const prefs = await getDb()
      .update(alertPreferencesTable)
      .set({
        whatsappTo: null,
        phone: null,
        email: null,
        contactSetByRole: null,
        whatsappEnabled: false,
        smsEnabled: false,
        emailEnabled: false,
        pushEnabled: false,
      })
      .where(eq(alertPreferencesTable.clientPartyId, partyId))
      .returning({ clientPartyId: alertPreferencesTable.clientPartyId });
    clearedPreferences = prefs.length;
    const devices = await getDb()
      .delete(pushDevicesTable)
      .where(eq(pushDevicesTable.clientPartyId, partyId))
      .returning({ id: pushDevicesTable.id });
    removedDevices = devices.length;
    // "Cleared" means rows were actually touched; a party that never stored
    // contact data reports lastEngagement=true, contactCleared=false.
    contactCleared = clearedPreferences + removedDevices > 0;
  }

  // ONE ledger event for the whole teardown, pointer-only (counts, never
  // contact values or names beyond the statutory identity the row keeps).
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    firmId,
    action: "party.offboard",
    entityType: "party",
    entityId: partyId,
    after: {
      engagementsArchived: archived.length,
      membershipsRemoved: removedMemberships.length,
      aliasesDeleted: deletedAliases.length,
      invitationsRevoked: revokedInvitations.length,
      alertPreferencesCleared: clearedPreferences,
      pushDevicesRemoved: removedDevices,
      contactCleared,
      lastEngagement,
    },
  });

  return {
    engagementsArchived: archived.length,
    membershipsRemoved: removedMemberships.length,
    aliasesDeleted: deletedAliases.length,
    contactCleared,
    lastEngagement,
  };
}
