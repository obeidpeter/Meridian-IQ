import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  bankStatementsTable,
  billingTiersTable,
  consentRecordsTable,
  engagementsTable,
  firmSubscriptionsTable,
  firmsTable,
  invoiceLinesTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import { firmPartySphereCondition } from "../party/party";

// Full-firm portability export (operator-gated, GET /firms/{id}/export). One
// deterministic bundle of everything the platform holds FOR a firm — the
// offboarding/regulator/acquirer answer to "give us our data". Read-only:
// nothing is mutated, nothing is stored; the route audits the export action
// itself (pointer-only).
//
// Section discipline:
//  - parties are the firm's SPHERE (firmPartySphereCondition — the shared
//    spine has no tenant key, so sphere scoping in app code IS the tenancy);
//  - statements ride as their summary rows only (line/parsed counts are
//    columns on the row) — raw bank_statement_lines are bulk transaction
//    data the bundle deliberately omits;
//  - members carry identity + role only: NEVER password hashes, TOTP
//    secrets/recovery codes, or session epochs;
//  - audit_events are the rows whose firm_id column names this firm — the
//    cross-tenant remainder of the ledger stays out.
// Every section is capped (cap+1 probe) and reports rows + a truncated flag
// in `counts`, so a partial bundle is always visibly partial.

export const EXPORT_SECTION_ROW_CAP = 10_000;

export interface FirmExportCount {
  section: string;
  rows: number;
  truncated: boolean;
}

export interface FirmExportBundle {
  firmId: string;
  exportedAt: string;
  sections: Record<string, Record<string, unknown>[]>;
  counts: FirmExportCount[];
}

// `cap` is injectable for tests only; production callers take the default.
export async function exportFirmData(
  firmId: string,
  cap: number = EXPORT_SECTION_ROW_CAP,
): Promise<FirmExportBundle> {
  const db = getDb();

  const [firm] = await db
    .select()
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  if (!firm) throw new DomainError("NOT_FOUND", "Firm not found", 404);

  const sections: Record<string, Record<string, unknown>[]> = {};
  const counts: FirmExportCount[] = [];
  // Drizzle rows are plain objects; the widening cast keeps the bundle shape
  // schema-friendly without an index signature on every row type.
  const addSection = (section: string, rows: object[]) => {
    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    sections[section] = kept as Record<string, unknown>[];
    counts.push({ section, rows: kept.length, truncated });
  };

  addSection("firm", [firm]);

  const subscription = await db
    .select({
      id: firmSubscriptionsTable.id,
      firmId: firmSubscriptionsTable.firmId,
      tierId: firmSubscriptionsTable.tierId,
      tierKey: billingTiersTable.key,
      tierName: billingTiersTable.name,
      status: firmSubscriptionsTable.status,
      startedAt: firmSubscriptionsTable.startedAt,
      updatedAt: firmSubscriptionsTable.updatedAt,
    })
    .from(firmSubscriptionsTable)
    .innerJoin(
      billingTiersTable,
      eq(billingTiersTable.id, firmSubscriptionsTable.tierId),
    )
    .where(eq(firmSubscriptionsTable.firmId, firmId))
    .limit(cap + 1);
  addSection("subscription", subscription);

  const sphere = db
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(firmPartySphereCondition(firmId));

  const parties = await db
    .select()
    .from(partiesTable)
    .where(firmPartySphereCondition(firmId))
    .orderBy(asc(partiesTable.createdAt), asc(partiesTable.id))
    .limit(cap + 1);
  addSection("parties", parties);

  const engagements = await db
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.firmId, firmId))
    .orderBy(asc(engagementsTable.createdAt), asc(engagementsTable.id))
    .limit(cap + 1);
  addSection("engagements", engagements);

  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.firmId, firmId))
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
          .where(eq(invoicesTable.firmId, firmId)),
      ),
    )
    .orderBy(asc(invoiceLinesTable.invoiceId), asc(invoiceLinesTable.lineNo))
    .limit(cap + 1);
  addSection("invoice_lines", invoiceLines);

  // Statement rows only: lineCount/parsedCount are columns, raw lines stay out.
  const statements = await db
    .select()
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.firmId, firmId))
    .orderBy(asc(bankStatementsTable.createdAt), asc(bankStatementsTable.id))
    .limit(cap + 1);
  addSection("statements", statements);

  const consent = await db
    .select()
    .from(consentRecordsTable)
    .where(inArray(consentRecordsTable.partyId, sphere))
    .orderBy(asc(consentRecordsTable.createdAt), asc(consentRecordsTable.id))
    .limit(cap + 1);
  addSection("consent_records", consent);

  // Identity + role only — the explicit column list IS the redaction:
  // passwordHash, totpSecret, totpRecoveryCodes, sessionEpoch never leave.
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
    .where(eq(membershipsTable.firmId, firmId))
    .orderBy(asc(membershipsTable.createdAt), asc(membershipsTable.id))
    .limit(cap + 1);
  addSection("members", members);

  // The ledger's firm_id is a text column; only rows naming THIS firm ride.
  const auditEvents = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.firmId, firmId))
    .orderBy(asc(auditEventsTable.seq))
    .limit(cap + 1);
  addSection("audit_events", auditEvents);

  return {
    firmId,
    exportedAt: new Date().toISOString(),
    sections,
    counts,
  };
}
