import { membershipsTable, usersTable } from "@workspace/db";

// Shared plumbing for the two portability exports (firm-export.ts and
// client-export.ts, self-described mirrors): the per-section cap accounting
// and the members redaction column list. One-homed so the mirrors cannot
// drift — the redaction list in particular is a security invariant the
// comments used to hold in lockstep by prose.

export interface ExportSectionCount {
  section: string;
  rows: number;
  truncated: boolean;
}

// The cap+1 probe: each section reads cap+1 rows; more than cap means the
// section is truncated to cap and visibly flagged, so a partial bundle is
// always visibly partial. Drizzle rows are plain objects; the widening cast
// keeps the bundle shape schema-friendly without an index signature on every
// row type.
export function makeSectionCollector(cap: number): {
  sections: Record<string, Record<string, unknown>[]>;
  counts: ExportSectionCount[];
  addSection: (section: string, rows: object[]) => void;
} {
  const sections: Record<string, Record<string, unknown>[]> = {};
  const counts: ExportSectionCount[] = [];
  const addSection = (section: string, rows: object[]): void => {
    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    sections[section] = kept as Record<string, unknown>[];
    counts.push({ section, rows: kept.length, truncated });
  };
  return { sections, counts, addSection };
}

// The members section carries identity + role only — this explicit column
// list IS the redaction: passwordHash, totpSecret, totpRecoveryCodes,
// sessionEpoch NEVER leave. Both exports select exactly this map (their WHERE
// clauses and lenses stay per-file); adding a column here adds it to both
// bundles, so treat any change as a redaction review.
export const MEMBER_EXPORT_COLUMNS = {
  membershipId: membershipsTable.id,
  userId: usersTable.id,
  email: usersTable.email,
  fullName: usersTable.fullName,
  role: membershipsTable.role,
  clientPartyId: membershipsTable.clientPartyId,
  createdAt: membershipsTable.createdAt,
} as const;
