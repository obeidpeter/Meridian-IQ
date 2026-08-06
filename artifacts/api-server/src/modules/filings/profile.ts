// Client Compliance Profile: the per-client statutory facts a HUMAN at the
// firm asserts — VAT registration, PAYE employer status, financial year end,
// incorporation date. Evidence-only throughout: the platform never infers a
// registration status from documents or models; a profile row exists because
// a firm principal said so, and mintFilingsForFirm's gates read it verbatim.
//
// ABSENCE SEMANTICS (load-bearing, mirrored from the schema comment): a
// client with NO profile row keeps the original Filing Desk behavior —
// monthly VAT and PAYE both mint, no annual rows. Only an asserted profile
// narrows the monthly gates and unlocks the annual kinds.
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  clientComplianceProfilesTable,
  engagementsTable,
  type ClientComplianceProfile,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { firmEngagesParty } from "../auth/rbac";
import { DomainError } from "../errors";
import { lagosDateString } from "../../lib/lagos-time";
import { LIVE_ENGAGEMENT } from "./filings";

export interface ComplianceProfileInput {
  vatRegistered: boolean;
  payeEmployer: boolean;
  fyeMonth?: number | null;
  incorporationDate?: string | null;
  notes?: string | null;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD and a real calendar date (the filings assertFilingDate posture,
// local so the module carries its own validation): the Date.UTC round-trip is
// the overflow check — V8 would happily read 2026-02-30 as March 2 — and the
// column is mode "string", so nothing else normalizes it.
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  );
}

// An incorporation date must be a real calendar date that has already
// happened (Lagos calendar — a company incorporated "tomorrow" is a typo,
// and the CAC annual gate reasons about elapsed years).
function assertIncorporationDate(value: string, now: Date): void {
  if (
    !DATE_SHAPE.test(value) ||
    !isRealCalendarDate(value) ||
    value > lagosDateString(now)
  ) {
    throw new DomainError(
      "PROFILE_BAD_DATE",
      "incorporationDate must be a real, non-future calendar date in YYYY-MM-DD form",
      400,
    );
  }
}

export async function getClientComplianceProfile(
  firmId: string,
  clientPartyId: string,
): Promise<ClientComplianceProfile | null> {
  const [row] = await getDb()
    .select()
    .from(clientComplianceProfilesTable)
    .where(
      and(
        eq(clientComplianceProfilesTable.firmId, firmId),
        eq(clientComplianceProfilesTable.clientPartyId, clientPartyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Assert (create or replace) the client's statutory profile — the natural
// upsert on the (firm, client) unique key. The client must be one the firm
// actually engages (rbac's firmEngagesParty — the ONE definition of "this
// client belongs to this firm"; any engagement counts, archived included,
// matching the retention-era read posture — the mint's LIVE wall still keeps
// a dormant book from growing rows). A foreign or unknown party is a 404
// indistinguishable from an id that does not exist (the loadFilingForScope
// non-disclosure posture).
export async function upsertComplianceProfile(
  firmId: string,
  clientPartyId: string,
  input: ComplianceProfileInput,
  updatedBy: string,
  now = new Date(),
): Promise<ClientComplianceProfile> {
  if (!(await firmEngagesParty(firmId, clientPartyId))) {
    throw new DomainError("NOT_FOUND", "Client not found", 404);
  }
  if (input.incorporationDate != null) {
    assertIncorporationDate(input.incorporationDate, now);
  }
  // Prior facts for the audit trail (null when this PUT creates the row).
  const existing = await getClientComplianceProfile(firmId, clientPartyId);
  const facts = {
    vatRegistered: input.vatRegistered,
    payeEmployer: input.payeEmployer,
    fyeMonth: input.fyeMonth ?? null,
    incorporationDate: input.incorporationDate ?? null,
  };
  const [row] = await getDb()
    .insert(clientComplianceProfilesTable)
    .values({
      firmId,
      clientPartyId,
      ...facts,
      notes: input.notes ?? null,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: [
        clientComplianceProfilesTable.firmId,
        clientComplianceProfilesTable.clientPartyId,
      ],
      set: {
        ...facts,
        notes: input.notes ?? null,
        updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  // Pointer-only audit (SEC-12, the filings status-walk shape): the asserted
  // statutory FACTS, never the free-text notes.
  await appendAudit({
    actorId: updatedBy,
    firmId,
    action: "filings.profile_updated",
    entityType: "compliance_profile",
    entityId: clientPartyId,
    before: existing
      ? {
          vatRegistered: existing.vatRegistered,
          payeEmployer: existing.payeEmployer,
          fyeMonth: existing.fyeMonth,
          incorporationDate: existing.incorporationDate,
        }
      : null,
    after: facts,
  });
  return row;
}

export interface ComplianceProfileSummary {
  // DISTINCT clients the firm ACTIVELY serves (the mint's LIVE_ENGAGEMENT
  // wall — the same population the Filing Desk mints for).
  clients: number;
  // Of those, how many carry an asserted profile row.
  profiled: number;
}

// One set-based pass: the live-client set LEFT JOINed to the firm's profile
// rows — never a query per client.
export async function complianceProfileSummary(
  firmId: string,
): Promise<ComplianceProfileSummary> {
  const rows = (
    await getDb().execute<{ clients: number; profiled: number }>(sql`
      SELECT
        COUNT(*)::int AS clients,
        COUNT(p.id)::int AS profiled
      FROM (
        SELECT DISTINCT ${engagementsTable.clientPartyId} AS client_party_id
        FROM ${engagementsTable}
        WHERE ${engagementsTable.firmId} = ${firmId} AND ${LIVE_ENGAGEMENT}
      ) c
      LEFT JOIN ${clientComplianceProfilesTable} p
        ON p.firm_id = ${firmId} AND p.client_party_id = c.client_party_id
    `)
  ).rows;
  const r = rows[0];
  return {
    clients: Number(r?.clients ?? 0),
    profiled: Number(r?.profiled ?? 0),
  };
}
