import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, obligationsTable, type Obligation } from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { lagosTodaySql } from "../../lib/lagos-time";

// Notice Desk obligations (Task #199): the structured record of "this client
// must respond to this authority by this date". Compliance-spine data like
// invoices — rows are created by the notice-review approve step or entered by
// firm staff by hand, never by a model.
//
// ONE HOME PER PREDICATE (the compliance-window.ts discipline): every
// "due soon" / "overdue" SQL fragment for obligations lives HERE, and every
// surface that speaks about obligation deadlines — the reminder sweep, the
// weekly digest, the month-end close, the compliance pack, Ask Clerk —
// imports it. Callers pass their own `today` (each site captures
// lagosTodaySql(); see lib/lagos-time.ts for why current_date is wrong).

// Notices deserve more runway than invoices' 3-day submission nudge: a
// response to an authority routinely needs documents gathered and a letter
// drafted, so the "due soon" window is a full week.
export const OBLIGATION_DUE_SOON_DAYS = 7;

// The fragments are alias-free (plain obligationsTable column refs) so they
// compose identically inside drizzle builders and raw `FROM obligations`
// SQL — unlike the invoice fragments, nothing here joins, so no alias is
// ever needed.

// Still awaiting a response — the only status the deadline clocks run on.
export const OBLIGATION_OPEN: SQL = sql`${obligationsTable.status} = 'open'`;

// The response date has PASSED: overdue starts the Lagos day AFTER the due
// date (`< today`, not `<=`) — on the due day itself the response can still
// be filed, so that day classifies as due-soon, never overdue.
export function obligationOverdue(today: SQL): SQL {
  return sql`${OBLIGATION_OPEN} AND ${obligationsTable.responseDueDate} < ${today}`;
}

// Due between today and today + OBLIGATION_DUE_SOON_DAYS inclusive.
export function obligationDueSoon(today: SQL): SQL {
  return sql`${OBLIGATION_OPEN}
    AND ${obligationsTable.responseDueDate} >= ${today}
    AND ${obligationsTable.responseDueDate} <= ${today} + ${OBLIGATION_DUE_SOON_DAYS}::int`;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
// numeric(18,2) column: reject anything that is not a plain decimal before it
// becomes a DB 500 (the assertPlainDecimalAmount posture, local so the module
// carries its own validation).
const AMOUNT_SHAPE = /^\d+(\.\d{1,2})?$/;

// YYYY-MM-DD and a real calendar date. The round-trip through Date.UTC is
// the overflow check (V8's parser would happily read 2026-02-30 as March 2);
// the date columns are mode "string", so nothing else normalizes these.
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  );
}

function assertObligationDate(value: string, field: string): void {
  if (!DATE_SHAPE.test(value) || !isRealCalendarDate(value)) {
    throw new DomainError(
      "OBLIGATION_BAD_DATE",
      `${field} must be a real calendar date in YYYY-MM-DD form`,
      400,
    );
  }
}

export interface ListObligationsFilter {
  clientPartyId?: string;
  status?: Obligation["status"];
  limit?: number;
  offset?: number;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 200;

// Soonest deadline first (the list is a worklist — the next clock to beat
// leads), id as the stable tiebreak.
export async function listObligations(
  firmId: string,
  filter: ListObligationsFilter = {},
): Promise<Obligation[]> {
  const conditions: SQL[] = [eq(obligationsTable.firmId, firmId)];
  if (filter.clientPartyId) {
    conditions.push(eq(obligationsTable.clientPartyId, filter.clientPartyId));
  }
  if (filter.status) {
    conditions.push(eq(obligationsTable.status, filter.status));
  }
  const limit = Math.min(filter.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  return getDb()
    .select()
    .from(obligationsTable)
    .where(and(...conditions))
    .orderBy(asc(obligationsTable.responseDueDate), asc(obligationsTable.id))
    .limit(limit)
    .offset(filter.offset ?? 0);
}

export interface CreateObligationInput {
  clientPartyId: string;
  noticeType: string;
  authority: string;
  reference?: string;
  taxType?: string;
  period?: string;
  amount?: string;
  currency?: string;
  issueDate?: string;
  responseDueDate: string;
  notes?: string;
  // The notice case this obligation was approved from; absent for manual
  // entry (paper notices recorded by firm staff).
  sourceCaseId?: string;
}

export async function createObligation(
  firmId: string,
  input: CreateObligationInput,
  actorId: string,
): Promise<Obligation> {
  assertObligationDate(input.responseDueDate, "responseDueDate");
  if (input.issueDate !== undefined) {
    assertObligationDate(input.issueDate, "issueDate");
  }
  if (input.amount !== undefined && !AMOUNT_SHAPE.test(input.amount)) {
    throw new DomainError(
      "OBLIGATION_BAD_AMOUNT",
      "amount must be a plain decimal string (e.g. 120000.00)",
      400,
    );
  }
  const [row] = await getDb()
    .insert(obligationsTable)
    .values({
      firmId,
      clientPartyId: input.clientPartyId,
      sourceCaseId: input.sourceCaseId ?? null,
      noticeType: input.noticeType,
      authority: input.authority,
      reference: input.reference ?? null,
      taxType: input.taxType ?? null,
      period: input.period ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      issueDate: input.issueDate ?? null,
      responseDueDate: input.responseDueDate,
      notes: input.notes ?? null,
      createdBy: actorId,
    })
    .returning();
  await appendAudit({
    actorId,
    firmId,
    action: "obligation.create",
    entityType: "obligation",
    entityId: row.id,
    after: {
      clientPartyId: row.clientPartyId,
      noticeType: row.noticeType,
      authority: row.authority,
      responseDueDate: row.responseDueDate,
      sourceCaseId: row.sourceCaseId,
    },
  });
  return row;
}

export async function getObligation(id: string): Promise<Obligation | null> {
  const [row] = await getDb()
    .select()
    .from(obligationsTable)
    .where(eq(obligationsTable.id, id))
    .limit(1);
  return row ?? null;
}

// Compare-and-set style: the UPDATE carries the firm predicate, so a foreign
// tenant's id (or an unknown one) updates zero rows and the caller 404s
// without ever learning which of the two it was.
export async function updateObligationStatus(
  id: string,
  firmId: string,
  status: Obligation["status"],
  notes: string | undefined,
  actorId: string,
): Promise<Obligation | null> {
  const [existing] = await getDb()
    .select({ status: obligationsTable.status })
    .from(obligationsTable)
    .where(and(eq(obligationsTable.id, id), eq(obligationsTable.firmId, firmId)))
    .limit(1);
  if (!existing) return null;
  const [row] = await getDb()
    .update(obligationsTable)
    .set({
      status,
      ...(notes !== undefined ? { notes } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(obligationsTable.id, id), eq(obligationsTable.firmId, firmId)))
    .returning();
  if (!row) return null;
  await appendAudit({
    actorId,
    firmId,
    action: "obligation.status",
    entityType: "obligation",
    entityId: row.id,
    before: { status: existing.status },
    after: { status: row.status },
  });
  return row;
}

export interface OpenObligationCounts {
  open: number;
  dueSoon: number;
  overdue: number;
  // Soonest open response date (YYYY-MM-DD), or null when nothing is open.
  nearestDue: string | null;
}

// THE single fact function: the digest, the month-end close, the compliance
// pack and Ask Clerk all call this — one SQL pass (FILTER clauses over the
// fragments above), so no two surfaces can disagree about the same firm's
// obligations.
export async function countOpenObligations(
  firmId: string,
  clientPartyId?: string,
): Promise<OpenObligationCounts> {
  const today = lagosTodaySql();
  const clientFilter = clientPartyId
    ? sql` AND ${obligationsTable.clientPartyId} = ${clientPartyId}`
    : sql``;
  const rows = (
    await getDb().execute<{
      open: number;
      due_soon: number;
      overdue: number;
      nearest_due: string | null;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE ${OBLIGATION_OPEN})::int AS open,
        COUNT(*) FILTER (WHERE ${obligationDueSoon(today)})::int AS due_soon,
        COUNT(*) FILTER (WHERE ${obligationOverdue(today)})::int AS overdue,
        (MIN(${obligationsTable.responseDueDate}) FILTER (WHERE ${OBLIGATION_OPEN}))::text AS nearest_due
      FROM ${obligationsTable}
      WHERE ${obligationsTable.firmId} = ${firmId}${clientFilter}
    `)
  ).rows;
  const r = rows[0];
  return {
    open: Number(r?.open ?? 0),
    dueSoon: Number(r?.due_soon ?? 0),
    overdue: Number(r?.overdue ?? 0),
    nearestDue: r?.nearest_due ?? null,
  };
}

export interface OpenObligationSample {
  id: string;
  authority: string;
  noticeType: string;
  reference: string | null;
  responseDueDate: string;
}

// Display sample for the compliance pack: open rows, newest deadline first,
// id as the stable tiebreak.
export async function openObligationSamples(
  firmId: string,
  clientPartyId?: string,
  limit = 5,
): Promise<OpenObligationSample[]> {
  const conditions: SQL[] = [eq(obligationsTable.firmId, firmId), OBLIGATION_OPEN];
  if (clientPartyId) {
    conditions.push(eq(obligationsTable.clientPartyId, clientPartyId));
  }
  return getDb()
    .select({
      id: obligationsTable.id,
      authority: obligationsTable.authority,
      noticeType: obligationsTable.noticeType,
      reference: obligationsTable.reference,
      responseDueDate: obligationsTable.responseDueDate,
    })
    .from(obligationsTable)
    .where(and(...conditions))
    .orderBy(desc(obligationsTable.responseDueDate), asc(obligationsTable.id))
    .limit(limit);
}
