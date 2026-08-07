// Filing Desk (Phase 1): the statutory returns register — one row per client
// × tax type × period, minted deterministically from the statutory calendar
// (never by hand and never by a model), then walked upcoming → prepared →
// filed by the firm. Evidence-only posture: MeridianIQ records that a return
// was prepared and filed (date + acknowledgment reference), it never files
// anything with an authority itself.
//
// ONE HOME PER PREDICATE (the obligations.ts discipline): every "unfiled" /
// "due soon" / "overdue" SQL fragment for filings lives HERE, and every
// surface that speaks about filing deadlines imports it. "Late" is
// deliberately NOT a status — it is derived from these fragments, so a row's
// history never rewrites itself at midnight. Callers pass their own `today`
// (each site captures lagosTodaySql(); see lib/lagos-time.ts for why
// current_date is wrong).
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  engagementsTable,
  filingReturnsTable,
  type FilingReturn,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";
import { lagosTodaySql } from "../../lib/lagos-time";
import { BILL_ORIENTATION } from "../invoice/receivables";
import {
  FILING_KINDS,
  filingDueDate,
  periodMonthBounds,
  previousLagosPeriod,
  type FilingTaxType,
} from "./statutory-calendar";

// Same runway as obligations, for the same reason: assembling a return needs
// figures gathered and reviewed, so the "due soon" window is a full week.
export const FILING_DUE_SOON_DAYS = 7;

// The fragments are alias-free (plain filingReturnsTable column refs) so they
// compose identically inside drizzle builders and raw `FROM filing_returns`
// SQL — nothing here joins, so no alias is ever needed.

// Not yet filed — the only condition the deadline clocks run on ("prepared"
// still owes the authority a return, so it stays on the clock).
export const FILING_UNFILED: SQL = sql`${filingReturnsTable.status} <> 'filed'`;

// The due date has PASSED: overdue starts the Lagos day AFTER the due date
// (`< today`, not `<=`) — on the due day itself the return can still be
// filed, so that day classifies as due-soon, never overdue.
export function filingOverdue(today: SQL): SQL {
  return sql`${FILING_UNFILED} AND ${filingReturnsTable.dueDate} < ${today}`;
}

// Due between today and today + FILING_DUE_SOON_DAYS inclusive.
export function filingDueSoon(today: SQL): SQL {
  return sql`${FILING_UNFILED}
    AND ${filingReturnsTable.dueDate} >= ${today}
    AND ${filingReturnsTable.dueDate} <= ${today} + ${FILING_DUE_SOON_DAYS}::int`;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD and a real calendar date (the obligations assertObligationDate
// posture, local so the module carries its own validation). The round-trip
// through Date.UTC is the overflow check — V8's parser would happily read
// 2026-02-30 as March 2 — and the date columns are mode "string", so nothing
// else normalizes these.
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  );
}

function assertFilingDate(value: string, field: string): void {
  if (!DATE_SHAPE.test(value) || !isRealCalendarDate(value)) {
    throw new DomainError(
      "FILING_BAD_DATE",
      `${field} must be a real calendar date in YYYY-MM-DD form`,
      400,
    );
  }
}

// The engagement statuses under which the firm ACTIVELY serves a client (the
// LIVE_ENGAGEMENT choice) — a paused book must not keep growing register rows.
// Deliberately spelled locally like the client-statement enumeration and the
// obligation reminder wall (rbac's firmEngagesParty counts ARCHIVED
// engagements for retention-era reads and must keep doing so).
const LIVE_ENGAGEMENT: SQL = sql`${engagementsTable.status} IN ('open', 'in_progress')`;

// Mint the last closed Lagos period's rows for one firm: every client the
// firm actively serves × each FILING_KINDS entry, due date computed once by
// the statutory calendar. Returns how many rows THIS call created (0 when
// already current). Idempotent by construction — the natural unique key
// (firm, client, tax, period) IS the cross-instance gate (the recurring
// materializer's discipline: exactly one winner per period, here decided by
// onConflictDoNothing on the index rather than a CAS), so the hourly sweep,
// a concurrent instance and a sync-now click can all race safely.
export async function mintFilingsForFirm(
  firmId: string,
  now = new Date(),
  // Onboarding backfill (round 42) pins ONE client: minting a past period
  // for a whole firm would backdate unfiled rows onto every client's
  // register at once — a book-wide behavior change no onboarding should
  // trigger. Absent, the enumeration is unchanged (the sweep's shape).
  onlyClientPartyId?: string,
): Promise<number> {
  const period = previousLagosPeriod(now);
  // selectDistinct because a client can hold several engagements with the
  // same firm (the client-statement enumeration's shape).
  const clients = await getDb()
    .selectDistinct({ clientPartyId: engagementsTable.clientPartyId })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        LIVE_ENGAGEMENT,
        ...(onlyClientPartyId
          ? [eq(engagementsTable.clientPartyId, onlyClientPartyId)]
          : []),
      ),
    );
  if (clients.length === 0) return 0;
  // WHT rows mint CONDITIONALLY (unlike vat/paye, which every live client
  // owes unconditionally): only a client that actually took delivery of a
  // withholding-categorised bill in the period has anything to remit, so a
  // wht register row for anyone else would be permanent noise. One
  // set-based pass: DISTINCT buyer parties over the period's
  // WHT-categorised, non-cancelled bills (the BILL_ORIENTATION fragment,
  // alias `i` — a captured vendor invoice, never the client's own paper),
  // intersected with the live-client set above.
  const { start, end } = periodMonthBounds(period);
  const whtBuyers = new Set(
    (
      await getDb().execute<{ client_party_id: string }>(sql`
        SELECT DISTINCT i.buyer_party_id AS client_party_id
        FROM invoices i
        WHERE i.firm_id = ${firmId}
          AND i.kind = 'invoice'
          AND i.wht_category IS NOT NULL
          AND i.status <> 'cancelled'
          AND ${BILL_ORIENTATION}
          AND i.issue_date >= ${start}::date
          AND i.issue_date < ${end}::date
      `)
    ).rows.map((r) => r.client_party_id),
  );
  const rows = clients.flatMap((c) =>
    FILING_KINDS.filter(
      (kind) =>
        kind.taxType !== "wht" || whtBuyers.has(c.clientPartyId),
    ).map((kind) => ({
      firmId,
      clientPartyId: c.clientPartyId,
      taxType: kind.taxType,
      period,
      dueDate: filingDueDate(period, kind.taxType),
      status: "upcoming" as const,
    })),
  );
  const inserted = await getDb()
    .insert(filingReturnsTable)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: filingReturnsTable.id });
  return inserted.length;
}

export interface ListFilingsFilter {
  clientPartyId?: string;
  status?: FilingReturn["status"];
  taxType?: FilingTaxType;
  limit?: number;
  offset?: number;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 200;

// Soonest deadline first (the register is a worklist — the next clock to
// beat leads), id as the stable tiebreak.
export async function listFilings(
  firmId: string,
  filter: ListFilingsFilter = {},
): Promise<FilingReturn[]> {
  const conditions: SQL[] = [eq(filingReturnsTable.firmId, firmId)];
  if (filter.clientPartyId) {
    conditions.push(eq(filingReturnsTable.clientPartyId, filter.clientPartyId));
  }
  if (filter.status) {
    conditions.push(eq(filingReturnsTable.status, filter.status));
  }
  if (filter.taxType) {
    conditions.push(eq(filingReturnsTable.taxType, filter.taxType));
  }
  const limit = Math.min(filter.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  return getDb()
    .select()
    .from(filingReturnsTable)
    .where(and(...conditions))
    .orderBy(asc(filingReturnsTable.dueDate), asc(filingReturnsTable.id))
    .limit(limit)
    .offset(filter.offset ?? 0);
}

export async function getFiling(id: string): Promise<FilingReturn | null> {
  const [row] = await getDb()
    .select()
    .from(filingReturnsTable)
    .where(eq(filingReturnsTable.id, id))
    .limit(1);
  return row ?? null;
}

// Load one register row under the 404 non-disclosure posture (the
// loadObligationForScope shape) — the ONE loader for any detail surface: a
// foreign tenant's row and a sibling client's row (SEC-03) are both
// indistinguishable from an id that does not exist.
export async function loadFilingForScope(
  id: string,
  principal: Principal,
): Promise<FilingReturn> {
  const row = await getFiling(id);
  const notFound = () => new DomainError("NOT_FOUND", "Filing not found", 404);
  if (!row) throw notFound();
  // CROSS_TENANT and CROSS_CLIENT both collapse to the same not-found the
  // missing id produces.
  try {
    assertSameTenant(principal, row.firmId);
    assertClientPartyScope(principal, row.clientPartyId);
  } catch {
    throw notFound();
  }
  return row;
}

export interface UpdateFilingStatusInput {
  status: "prepared" | "filed";
  filedDate?: string;
  filedReference?: string;
  notes?: string;
}

// The forward-only walk: upcoming → prepared, upcoming → filed (a firm may
// record both acts at once), prepared → filed. Everything else — backward or
// same-status — is a 409, so the register's history only ever advances.
const LEGAL_TRANSITIONS: Record<FilingReturn["status"], readonly string[]> = {
  upcoming: ["prepared", "filed"],
  prepared: ["filed"],
  filed: [],
};

// Compare-and-set style (the obligations pattern): both the SELECT and the
// UPDATE carry the firm predicate, so a foreign tenant's id (or an unknown
// one) touches zero rows and the caller 404s without ever learning which of
// the two it was. Returns null for that case; throws for a real row asked to
// move illegally.
export async function updateFilingStatus(
  id: string,
  firmId: string,
  input: UpdateFilingStatusInput,
  userId: string,
): Promise<FilingReturn | null> {
  if (input.status === "filed") {
    // Filing is an evidence-bearing act: the date is mandatory, the
    // authority's acknowledgment reference optional (formats vary).
    if (input.filedDate === undefined) {
      throw new DomainError(
        "FILING_BAD_DATE",
        "filedDate is required to mark a return filed",
        400,
      );
    }
    assertFilingDate(input.filedDate, "filedDate");
  } else if (input.filedDate !== undefined || input.filedReference !== undefined) {
    // "Prepared" carries no filing evidence — accepting it here would let a
    // row look half-filed without the status that makes the claim.
    throw new DomainError(
      "FILING_UNEXPECTED_EVIDENCE",
      "filedDate/filedReference only accompany status \"filed\"",
      400,
    );
  }
  const [existing] = await getDb()
    .select({ status: filingReturnsTable.status })
    .from(filingReturnsTable)
    .where(
      and(eq(filingReturnsTable.id, id), eq(filingReturnsTable.firmId, firmId)),
    )
    .limit(1);
  if (!existing) return null;
  if (!LEGAL_TRANSITIONS[existing.status].includes(input.status)) {
    throw new DomainError(
      "FILING_BAD_TRANSITION",
      `A ${existing.status} return cannot move to ${input.status}`,
      409,
    );
  }
  const [row] = await getDb()
    .update(filingReturnsTable)
    .set({
      status: input.status,
      // Each transition records its own actor: preparedBy on the prepare,
      // filedBy on the file — a direct upcoming → filed sets only filedBy
      // (nobody separately prepared).
      ...(input.status === "prepared"
        ? { preparedBy: userId }
        : {
            filedBy: userId,
            filedDate: input.filedDate,
            filedReference: input.filedReference ?? null,
          }),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(filingReturnsTable.id, id), eq(filingReturnsTable.firmId, firmId)),
    )
    .returning();
  if (!row) return null;
  // Pointer-only audit (SEC-12): the walk itself plus which return moved —
  // never the evidence reference.
  await appendAudit({
    actorId: userId,
    firmId,
    action: "filing.status",
    entityType: "filing_return",
    entityId: row.id,
    before: { status: existing.status },
    after: { status: row.status, taxType: row.taxType, period: row.period },
  });
  return row;
}

export interface OpenFilingCounts {
  unfiled: number;
  dueSoon: number;
  overdue: number;
  // Soonest unfiled due date (YYYY-MM-DD), or null when everything is filed.
  nextDueDate: string | null;
}

// THE single fact function (the countOpenObligations pattern): future
// consumers — the weekly digest, the month-end close, the compliance pack —
// must call this rather than re-derive, one SQL pass (FILTER clauses over the
// fragments above) so no two surfaces can disagree about the same firm's
// register. `todaySql` is injectable for tests; every production site takes
// the default Lagos today.
export async function countOpenFilings(
  firmId: string,
  clientPartyId?: string,
  todaySql: SQL = lagosTodaySql(),
): Promise<OpenFilingCounts> {
  const clientFilter = clientPartyId
    ? sql` AND ${filingReturnsTable.clientPartyId} = ${clientPartyId}`
    : sql``;
  const rows = (
    await getDb().execute<{
      unfiled: number;
      due_soon: number;
      overdue: number;
      next_due: string | null;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE ${FILING_UNFILED})::int AS unfiled,
        COUNT(*) FILTER (WHERE ${filingDueSoon(todaySql)})::int AS due_soon,
        COUNT(*) FILTER (WHERE ${filingOverdue(todaySql)})::int AS overdue,
        (MIN(${filingReturnsTable.dueDate}) FILTER (WHERE ${FILING_UNFILED}))::text AS next_due
      FROM ${filingReturnsTable}
      WHERE ${filingReturnsTable.firmId} = ${firmId}${clientFilter}
    `)
  ).rows;
  const r = rows[0];
  return {
    unfiled: Number(r?.unfiled ?? 0),
    dueSoon: Number(r?.due_soon ?? 0),
    overdue: Number(r?.overdue ?? 0),
    nextDueDate: r?.next_due ?? null,
  };
}

export interface OpenFilingSample {
  id: string;
  taxType: string;
  period: string;
  dueDate: string;
  status: FilingReturn["status"];
}

// Display sample for the compliance pack (the openObligationSamples mirror):
// unfiled rows, soonest statutory date first — the register is a worklist,
// so the next clock to beat leads — id as the stable tiebreak.
export async function openFilingSamples(
  firmId: string,
  clientPartyId?: string,
  limit = 5,
): Promise<OpenFilingSample[]> {
  const conditions: SQL[] = [
    eq(filingReturnsTable.firmId, firmId),
    FILING_UNFILED,
  ];
  if (clientPartyId) {
    conditions.push(eq(filingReturnsTable.clientPartyId, clientPartyId));
  }
  return getDb()
    .select({
      id: filingReturnsTable.id,
      taxType: filingReturnsTable.taxType,
      period: filingReturnsTable.period,
      dueDate: filingReturnsTable.dueDate,
      status: filingReturnsTable.status,
    })
    .from(filingReturnsTable)
    .where(and(...conditions))
    .orderBy(asc(filingReturnsTable.dueDate), asc(filingReturnsTable.id))
    .limit(limit);
}
