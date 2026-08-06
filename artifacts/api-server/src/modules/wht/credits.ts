// WHT Desk: the withholding-tax credit ledger. One row per invoice on which
// a buyer actually withheld — minted when a deduction is RECORDED (a human
// accepting a short-pay reconciliation match, or recording it by hand),
// never speculatively from the category alone. Evidence-only posture (the
// filing_returns idiom): MeridianIQ records that a credit note was received
// (reference + date), it never claims anything with an authority itself.
//
// ONE HOME PER FACT (the countOpenFilings discipline): whtCreditTotals below
// is the single SQL pass every chase surface — the ledger's own totals, the
// digest, the month-end close, the compliance pack and the Ask intent —
// composes, so no two surfaces can disagree about the same firm's chase.
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  whtCreditsTable,
  type WhtCredit,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";
import { whtExpectedSql } from "./rates";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD and a real calendar date — the filings assertFilingDate posture
// (kept local, like every module carrying its own date validation): the
// round-trip through Date.UTC is the overflow check (V8 would happily read
// 2026-02-30 as March 2), and the date columns are mode "string", so nothing
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

function assertWhtDate(value: string, field: string): void {
  if (!DATE_SHAPE.test(value) || !isRealCalendarDate(value)) {
    throw new DomainError(
      "WHT_BAD_DATE",
      `${field} must be a real calendar date in YYYY-MM-DD form`,
      400,
    );
  }
}

// The amount column is numeric(18,2): reject anything the insert would turn
// into an opaque DB error, and zero/negative figures that would corrupt the
// chase totals (the assertValidFxRate posture).
function assertValidAmount(amount: string): void {
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    throw new DomainError(
      "WHT_BAD_AMOUNT",
      `amount must be a positive decimal with at most 2 decimal places, got "${amount}"`,
      400,
    );
  }
}

// A ledger row joined with its invoice number — the contract's WhtCredit
// shape (parse-ready for the generated response schemas).
export interface WhtCreditView {
  id: string;
  firmId: string;
  clientPartyId: string;
  invoiceId: string;
  invoiceNumber: string;
  category: string;
  amount: string;
  deductedDate: string;
  source: string;
  status: WhtCredit["status"];
  noteReference: string | null;
  noteDate: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const viewColumns = {
  id: whtCreditsTable.id,
  firmId: whtCreditsTable.firmId,
  clientPartyId: whtCreditsTable.clientPartyId,
  invoiceId: whtCreditsTable.invoiceId,
  invoiceNumber: invoicesTable.invoiceNumber,
  category: whtCreditsTable.category,
  amount: whtCreditsTable.amount,
  deductedDate: whtCreditsTable.deductedDate,
  source: whtCreditsTable.source,
  status: whtCreditsTable.status,
  noteReference: whtCreditsTable.noteReference,
  noteDate: whtCreditsTable.noteDate,
  createdAt: whtCreditsTable.createdAt,
  updatedAt: whtCreditsTable.updatedAt,
};

async function loadCreditView(id: string): Promise<WhtCreditView | null> {
  const [row] = await getDb()
    .select(viewColumns)
    .from(whtCreditsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, whtCreditsTable.invoiceId))
    .where(eq(whtCreditsTable.id, id))
    .limit(1);
  return row ?? null;
}

export interface RecordWhtCreditInput {
  amount?: string;
  deductedDate: string;
  source: "statement_match" | "manual";
  recordedBy?: string;
}

// Record that a buyer withheld on an invoice. Idempotent — the unique
// invoiceId index IS the cross-instance gate: onConflictDoNothing then
// SELECT the surviving row, so a manual record and an accepted short-pay
// match of the same deduction leave exactly one credit (the route answers
// 201 with the survivor either way). Amount defaults to the SQL-computed
// expectation (subtotal × the category's rate — modules/wht/rates.ts, the
// one home); a human may record the buyer's real figure instead. The model
// never assigns a category and never creates a credit: the category is read
// off the invoice a human already categorised, and every caller is a human
// act (a route write or an accepted proposal).
export async function recordWhtCredit(
  firmId: string,
  invoiceId: string,
  input: RecordWhtCreditInput,
): Promise<WhtCreditView> {
  assertWhtDate(input.deductedDate, "deductedDate");
  if (input.amount !== undefined) assertValidAmount(input.amount);
  const [invoice] = await getDb()
    .select({
      id: invoicesTable.id,
      supplierPartyId: invoicesTable.supplierPartyId,
      whtCategory: invoicesTable.whtCategory,
      // The expected WHT, computed in SQL by the shared CASE builder — the
      // default amount when the caller supplies none.
      expected: sql<string | null>`${whtExpectedSql(
        sql`${invoicesTable.subtotal}`,
        sql`${invoicesTable.whtCategory}`,
      )}::text`,
    })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.firmId, firmId)))
    .limit(1);
  if (!invoice) {
    throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  }
  if (invoice.whtCategory === null) {
    throw new DomainError(
      "WHT_NO_CATEGORY",
      "The invoice carries no WHT category — set one before recording a deduction",
      400,
    );
  }
  const amount = input.amount ?? invoice.expected;
  if (amount === null) {
    // Unreachable through contract-bound writes (the whtCategory enum is the
    // catalogue); guards a raw category the rates table does not know.
    throw new DomainError(
      "WHT_NO_CATEGORY",
      `No withholding rate is defined for category "${invoice.whtCategory}"`,
      400,
    );
  }
  const inserted = await getDb()
    .insert(whtCreditsTable)
    .values({
      firmId,
      clientPartyId: invoice.supplierPartyId,
      invoiceId,
      category: invoice.whtCategory,
      amount,
      deductedDate: input.deductedDate,
      source: input.source,
      recordedBy: input.recordedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: whtCreditsTable.id });
  if (inserted.length > 0) {
    // Pointer-only audit (SEC-12): the act and its catalogue key — never the
    // naira figure.
    await appendAudit({
      actorId: input.recordedBy ?? null,
      firmId,
      action: "wht.credit.record",
      entityType: "wht_credit",
      entityId: inserted[0].id,
      after: {
        invoiceId,
        category: invoice.whtCategory,
        source: input.source,
      },
    });
  }
  // SELECT the survivor (ours or the earlier winner's) joined for the
  // invoice number the contract echoes.
  const [survivor] = await getDb()
    .select(viewColumns)
    .from(whtCreditsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, whtCreditsTable.invoiceId))
    .where(eq(whtCreditsTable.invoiceId, invoiceId))
    .limit(1);
  return survivor;
}

// Load one credit under the 404 non-disclosure posture (the
// loadFilingForScope shape): a foreign tenant's row and a sibling client's
// row (SEC-03) are both indistinguishable from an id that does not exist.
export async function loadWhtCreditForScope(
  id: string,
  principal: Principal,
): Promise<WhtCreditView> {
  const row = await loadCreditView(id);
  const notFound = () => new DomainError("NOT_FOUND", "Credit not found", 404);
  if (!row) throw notFound();
  try {
    assertSameTenant(principal, row.firmId);
    assertClientPartyScope(principal, row.clientPartyId);
  } catch {
    throw notFound();
  }
  return row;
}

export interface WhtNoteInput {
  noteReference: string;
  noteDate: string;
}

// Forward-only: awaiting_note → note_received, once. Compare-and-set style
// (the updateFilingStatus posture): both the SELECT and the UPDATE carry the
// firm predicate, so a foreign tenant's id touches zero rows and the caller
// 404s without disclosure. Returns null for that case; throws 409 for a real
// row already marked received.
export async function markWhtNoteReceived(
  firmId: string,
  creditId: string,
  input: WhtNoteInput,
  userId?: string,
): Promise<WhtCreditView | null> {
  assertWhtDate(input.noteDate, "noteDate");
  const [existing] = await getDb()
    .select({ status: whtCreditsTable.status })
    .from(whtCreditsTable)
    .where(and(eq(whtCreditsTable.id, creditId), eq(whtCreditsTable.firmId, firmId)))
    .limit(1);
  if (!existing) return null;
  if (existing.status === "note_received") {
    throw new DomainError(
      "WHT_BAD_TRANSITION",
      "The credit note is already recorded as received",
      409,
    );
  }
  const [row] = await getDb()
    .update(whtCreditsTable)
    .set({
      status: "note_received",
      noteReference: input.noteReference,
      noteDate: input.noteDate,
      updatedAt: new Date(),
    })
    .where(and(eq(whtCreditsTable.id, creditId), eq(whtCreditsTable.firmId, firmId)))
    .returning({ id: whtCreditsTable.id });
  if (!row) return null;
  // Pointer-only audit (SEC-12): the walk itself — never the evidence
  // reference (the filings updateFilingStatus rule).
  await appendAudit({
    actorId: userId ?? null,
    firmId,
    action: "wht.credit.note",
    entityType: "wht_credit",
    entityId: creditId,
    before: { status: "awaiting_note" },
    after: { status: "note_received" },
  });
  return loadCreditView(creditId);
}

export interface WhtCreditTotals {
  awaitingNote: number;
  noteReceived: number;
  awaitingAmount: string;
  totalAmount: string;
}

// THE single fact pass (the countOpenFilings pattern): counts and naira sums
// over the (firm, optional client) scope in one set-based SQL statement —
// FILTER clauses, decimal-string sums (numeric never crosses through JS
// floats). Every chase consumer composes this.
export async function whtCreditTotals(
  firmId: string,
  clientPartyId?: string,
): Promise<WhtCreditTotals> {
  const clientFilter = clientPartyId
    ? sql` AND ${whtCreditsTable.clientPartyId} = ${clientPartyId}`
    : sql``;
  const rows = (
    await getDb().execute<{
      awaiting: number;
      received: number;
      awaiting_amount: string;
      total_amount: string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE ${whtCreditsTable.status} = 'awaiting_note')::int AS awaiting,
        COUNT(*) FILTER (WHERE ${whtCreditsTable.status} = 'note_received')::int AS received,
        COALESCE(SUM(${whtCreditsTable.amount}) FILTER (WHERE ${whtCreditsTable.status} = 'awaiting_note'), 0.00)::text AS awaiting_amount,
        COALESCE(SUM(${whtCreditsTable.amount}), 0.00)::text AS total_amount
      FROM ${whtCreditsTable}
      WHERE ${whtCreditsTable.firmId} = ${firmId}${clientFilter}
    `)
  ).rows;
  const r = rows[0];
  return {
    awaitingNote: Number(r?.awaiting ?? 0),
    noteReceived: Number(r?.received ?? 0),
    awaitingAmount: String(r?.awaiting_amount ?? "0.00"),
    totalAmount: String(r?.total_amount ?? "0.00"),
  };
}

export interface ListWhtCreditsFilter {
  clientPartyId?: string;
  status?: WhtCredit["status"];
  limit?: number;
  offset?: number;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 200;

// The ledger, most recent deduction first (id as the stable tiebreak), with
// the chase totals. Totals cover the whole (firm, client) scope regardless
// of the status filter or paging — the header numbers must not change when
// the list is filtered. SEC-03 is the ROUTE's job (narrowToClientPartyScope
// pins a client_user's filter before this runs); the module only filters.
export async function listWhtCredits(
  firmId: string,
  filter: ListWhtCreditsFilter = {},
): Promise<{ credits: WhtCreditView[]; totals: WhtCreditTotals }> {
  const conditions: SQL[] = [eq(whtCreditsTable.firmId, firmId)];
  if (filter.clientPartyId) {
    conditions.push(eq(whtCreditsTable.clientPartyId, filter.clientPartyId));
  }
  if (filter.status) {
    conditions.push(eq(whtCreditsTable.status, filter.status));
  }
  const limit = Math.min(filter.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const credits = await getDb()
    .select(viewColumns)
    .from(whtCreditsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, whtCreditsTable.invoiceId))
    .where(and(...conditions))
    .orderBy(desc(whtCreditsTable.deductedDate), asc(whtCreditsTable.id))
    .limit(limit)
    .offset(filter.offset ?? 0);
  const totals = await whtCreditTotals(firmId, filter.clientPartyId);
  return { credits, totals };
}

// The chase fact for the digest / month-end close / compliance pack / Ask —
// one home (the countOpenFilings precedent), composed from the single totals
// pass above.
export async function countWhtChase(
  firmId: string,
  clientPartyId?: string,
): Promise<{ awaiting: number; awaitingAmount: string }> {
  const totals = await whtCreditTotals(firmId, clientPartyId);
  return { awaiting: totals.awaitingNote, awaitingAmount: totals.awaitingAmount };
}

export interface OpenWhtSample {
  invoiceNumber: string;
  category: string;
  amount: string;
  deductedDate: string;
}

// Display sample for the compliance pack (the openFilingSamples mirror):
// awaiting_note rows, oldest deduction first — the stalest chase leads — id
// as the stable tiebreak.
export async function openWhtSamples(
  firmId: string,
  clientPartyId: string,
  limit = 5,
): Promise<OpenWhtSample[]> {
  return getDb()
    .select({
      invoiceNumber: invoicesTable.invoiceNumber,
      category: whtCreditsTable.category,
      amount: whtCreditsTable.amount,
      deductedDate: whtCreditsTable.deductedDate,
    })
    .from(whtCreditsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, whtCreditsTable.invoiceId))
    .where(
      and(
        eq(whtCreditsTable.firmId, firmId),
        eq(whtCreditsTable.clientPartyId, clientPartyId),
        eq(whtCreditsTable.status, "awaiting_note"),
      ),
    )
    .orderBy(asc(whtCreditsTable.deductedDate), asc(whtCreditsTable.id))
    .limit(limit);
}
