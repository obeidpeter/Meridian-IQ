import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  db as baseDb,
  alertPreferencesTable,
  auditEventsTable,
  bankStatementsTable,
  consentRecordsTable,
  engagementsTable,
  escalationsTable,
  invoiceLinesTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import { EXPORT_SECTION_ROW_CAP } from "./firm-export";

// Client data-subject export (NDPA data portability, GET /clients/{id}/export).
// One deterministic bundle of everything the platform holds ABOUT one client
// party — the data-subject-access answer for the client itself, the engaging
// firm, or an operator. Read-only: nothing is mutated, nothing is stored; the
// route audits the export action itself (pointer-only), AFTER assembly, so the
// bundle never contains its own event.
//
// TENANT LENS (`firmLens`): parties are the SHARED SPINE — one party may be
// engaged by several firms — but engagements, invoices, statements,
// escalations and memberships are firm-tenant rows. The module reads on the
// base client (RLS bypass; same posture as firm-export), so the lens in app
// code IS the tenancy:
//  - firm-scoped callers pass their own firmId: every firm-keyed section is
//    filtered to that tenant's slice (another firm's pipeline for the same
//    party must never leak through a shared client — SEC-02/03);
//  - the data subject's own client_user and cross-tenant staff
//    (operator/auditor) pass null: the subject's data across ALL engaging
//    firms rides, which is what a data-subject access request means.
// Party-keyed sections (the party row, consent_records, alert_preferences)
// are the subject's own data and are never lensed.
//
// Section discipline (mirrors firm-export):
//  - the party row rides whole — legal_name/tin/cac ARE the subject's data;
//  - invoices are the rows where the party is the SUPPLIER (its own sales
//    book); invoice_lines ride via the same invoice sub-select;
//  - statements ride as summary rows only (line/parsed counts are columns) —
//    raw bank_statement_lines are bulk transaction data the bundle omits;
//  - members carry identity + role only (the explicit column list IS the
//    redaction): NEVER password hashes, TOTP secrets/recovery codes, or
//    session epochs — byte-for-byte the firm-export members column list;
//  - alert_preferences is the party's contact row — whatsappTo/phone/email
//    are the data subject's own contact PII, so they belong in ITS bundle;
//  - audit_events are the ledger rows with entity_type='party' naming this
//    party. Invoice-level events (submissions, stamps) are reachable through
//    the invoice ids already in the bundle — they are deliberately not
//    duplicated here. Under a firm lens, only rows written in that firm's
//    tenant (or tenant-neutral rows, firm_id NULL — e.g. party.create) ride.
// Every section is capped (cap+1 probe) and reports rows + a truncated flag
// in `counts`, so a partial bundle is always visibly partial.

export interface ClientExportCount {
  section: string;
  rows: number;
  truncated: boolean;
}

export interface ClientExportBundle {
  partyId: string;
  firmId: string | null;
  exportedAt: string;
  sections: Record<string, Record<string, unknown>[]>;
  counts: ClientExportCount[];
}

// `cap` is injectable for tests only; production callers take the default.
//
// SNAPSHOT DISCIPLINE (mirrors firm-export): all sections run inside ONE
// explicit REPEATABLE READ read-only transaction on the base client, so every
// read sees the same MVCC snapshot — an invoice_lines row can never disagree
// with the invoices section it belongs to. The base client (not the ambient
// request transaction) is required twice over: the request tx's isolation
// level is fixed by the time a handler runs, and firm-keyed RLS in the
// request context would hide the cross-firm rows the subject/operator views
// legitimately include. Route-level guards (assertPartyAccess /
// assertClientPartyScope) plus the lens above are the access control.
export async function exportClientData(
  partyId: string,
  firmLens: string | null,
  cap: number = EXPORT_SECTION_ROW_CAP,
): Promise<ClientExportBundle> {
  return baseDb.transaction(
    (tx) => exportClientDataWithin(tx, partyId, firmLens, cap),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function exportClientDataWithin(
  db: Pick<typeof baseDb, "select">,
  partyId: string,
  firmLens: string | null,
  cap: number,
): Promise<ClientExportBundle> {
  const [party] = await db
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, partyId))
    .limit(1);
  if (!party) throw new DomainError("NOT_FOUND", "Client party not found", 404);

  const sections: Record<string, Record<string, unknown>[]> = {};
  const counts: ClientExportCount[] = [];
  const addSection = (section: string, rows: object[]) => {
    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    sections[section] = kept as Record<string, unknown>[];
    counts.push({ section, rows: kept.length, truncated });
  };

  addSection("party", [party]);

  const engagementWhere: SQL | undefined = and(
    eq(engagementsTable.clientPartyId, partyId),
    ...(firmLens ? [eq(engagementsTable.firmId, firmLens)] : []),
  );
  const engagements = await db
    .select()
    .from(engagementsTable)
    .where(engagementWhere)
    .orderBy(asc(engagementsTable.createdAt), asc(engagementsTable.id))
    .limit(cap + 1);
  addSection("engagements", engagements);

  // The party's own sales book: rows where it is the supplier.
  const invoiceWhere: SQL | undefined = and(
    eq(invoicesTable.supplierPartyId, partyId),
    ...(firmLens ? [eq(invoicesTable.firmId, firmLens)] : []),
  );
  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(invoiceWhere)
    .orderBy(asc(invoicesTable.createdAt), asc(invoicesTable.id))
    .limit(cap + 1);
  addSection("invoices", invoices);

  const invoiceLines = await db
    .select()
    .from(invoiceLinesTable)
    .where(
      inArray(
        invoiceLinesTable.invoiceId,
        db
          .select({ id: invoicesTable.id })
          .from(invoicesTable)
          .where(invoiceWhere),
      ),
    )
    .orderBy(asc(invoiceLinesTable.invoiceId), asc(invoiceLinesTable.lineNo))
    .limit(cap + 1);
  addSection("invoice_lines", invoiceLines);

  // Statement rows only: lineCount/parsedCount are columns, raw lines stay out.
  const statements = await db
    .select()
    .from(bankStatementsTable)
    .where(
      and(
        eq(bankStatementsTable.clientPartyId, partyId),
        ...(firmLens ? [eq(bankStatementsTable.firmId, firmLens)] : []),
      ),
    )
    .orderBy(asc(bankStatementsTable.createdAt), asc(bankStatementsTable.id))
    .limit(cap + 1);
  addSection("statements", statements);

  // Consent is client-owned (CORE-03) — never lensed.
  const consent = await db
    .select()
    .from(consentRecordsTable)
    .where(eq(consentRecordsTable.partyId, partyId))
    .orderBy(asc(consentRecordsTable.createdAt), asc(consentRecordsTable.id))
    .limit(cap + 1);
  addSection("consent_records", consent);

  // Identity + role only — the explicit column list IS the redaction
  // (identical to firm-export's members section): passwordHash, totpSecret,
  // totpRecoveryCodes, sessionEpoch never leave.
  const members = await db
    .select({
      membershipId: membershipsTable.id,
      userId: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      createdAt: membershipsTable.createdAt,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(
      and(
        eq(membershipsTable.clientPartyId, partyId),
        ...(firmLens ? [eq(membershipsTable.firmId, firmLens)] : []),
      ),
    )
    .orderBy(asc(membershipsTable.createdAt), asc(membershipsTable.id))
    .limit(cap + 1);
  addSection("members", members);

  // The data subject's contact row (SME-05) — this IS the subject's own
  // contact data, so it rides un-lensed (the row is party-keyed and shared
  // across engaging firms by design).
  const alertPreferences = await db
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, partyId))
    .limit(cap + 1);
  addSection("alert_preferences", alertPreferences);

  const escalations = await db
    .select()
    .from(escalationsTable)
    .where(
      and(
        eq(escalationsTable.clientPartyId, partyId),
        ...(firmLens ? [eq(escalationsTable.firmId, firmLens)] : []),
      ),
    )
    .orderBy(asc(escalationsTable.createdAt), asc(escalationsTable.id))
    .limit(cap + 1);
  addSection("escalations", escalations);

  // Party-entity ledger rows. Tenant-neutral rows (firm_id NULL — e.g.
  // party.create/party.update written by the shared-spine module) always
  // ride; under a firm lens, other tenants' rows about the shared party
  // (e.g. another firm's offboard counts) stay out.
  const auditEvents = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "party"),
        eq(auditEventsTable.entityId, partyId),
        ...(firmLens
          ? [
              or(
                isNull(auditEventsTable.firmId),
                eq(auditEventsTable.firmId, firmLens),
              ),
            ]
          : []),
      ),
    )
    .orderBy(asc(auditEventsTable.seq))
    .limit(cap + 1);
  addSection("audit_events", auditEvents);

  return {
    partyId,
    firmId: firmLens,
    exportedAt: new Date().toISOString(),
    sections,
    counts,
  };
}

// Re-export so route/tests can reference one canonical cap.
export { EXPORT_SECTION_ROW_CAP };
