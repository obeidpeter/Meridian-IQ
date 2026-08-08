import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  partiesTable,
  stampRecordsTable,
  confirmationsTable,
  buyerExposureSnapshotsTable,
  type Invoice,
} from "@workspace/db";
import {
  canTransition,
  isPresentableAsEligible,
  recordTransition,
} from "../invoice/lifecycle.ts";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { assertBuyerPartyAccess, type Principal } from "../auth/rbac";

// Buyer Rails v1 read models (BR-01, BR-05).
//
// A buyer's supplier list, input-VAT exposure and compliance scoreboard are all
// derived from the invoices addressed to the buyer's Party. Exposure is served
// from a snapshot refreshed at least daily (BR-01): reads fall back to an
// on-demand compute when the latest snapshot is stale or absent, and the
// pipeline worker sweeps proactively.

export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SupplierSummary {
  supplierPartyId: string;
  supplierName: string;
  supplierTin: string | null;
  tinValidated: boolean;
  invoiceCount: number;
  stampedCount: number;
  eligibleCount: number;
  totalAmount: string;
  vatProtected: string;
  vatAtRisk: string;
}

export interface ExposureComputation {
  buyerPartyId: string;
  supplierCount: number;
  invoiceCount: number;
  protectedVat: string;
  atRiskVat: string;
  breakdown: SupplierSummary[];
  computedAt: Date;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export interface InvoiceFacts {
  invoice: Invoice;
  stamped: boolean;
  eligible: boolean;
  latestConfirmation: string | null;
  // When the latest lineage row was written — for an invoice whose latest
  // state is `requested`, this is when the confirmation was requested (the
  // pending-confirmations CSV's requestedAt column).
  latestConfirmationAt: Date | null;
}

type BuyerConfirmationState =
  | "none"
  | "requested"
  | "confirmed"
  | "queried"
  | "rejected";

export interface BuyerInvoiceSummary {
  total: number;
  awaitingTotal: string;
  counts: Record<BuyerConfirmationState, number>;
}

// Statuses visible to the buyer organization. Drafts (and locally-validated
// drafts) are the supplier firm's private mutable working state — an invoice
// only exists outside its firm once submitted (CORE-02) — so they must never
// leak into another organization's portal, exposure or scoreboard.
const BUYER_VISIBLE_STATUSES = [
  "submitted",
  "stamped",
  "confirmed",
  "settled",
  "failed",
  "cancelled",
  "credited",
] as const;

// Load the buyer's invoice book with stamp and confirmation facts resolved in
// three indexed selects (never per-invoice queries — the batch discipline of
// verifyStampBatch).
export async function loadBuyerBook(
  buyerPartyId: string,
  options?: {
    limit: number;
    offset: number;
    confirmationState?:
      | "none"
      | "requested"
      | "confirmed"
      | "queried"
      | "rejected";
    invoiceId?: string;
    supplierPartyId?: string;
    search?: string;
  },
): Promise<InvoiceFacts[]> {
  const latestConfirmation = sql`(
    SELECT c.state::text
      FROM confirmations c
     WHERE c.invoice_id = ${invoicesTable.id}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 1
  )`;
  const statePredicate = options?.confirmationState
    ? options.confirmationState === "none"
      ? sql`${latestConfirmation} IS NULL`
      : sql`${latestConfirmation} = ${options.confirmationState}`
    : undefined;
  const search = options?.search?.trim();
  const searchPattern = search
    ? `%${search.replace(/[\\%_]/g, "\\$&")}%`
    : undefined;
  const searchPredicate = search
    ? or(
        sql`${invoicesTable.invoiceNumber} ILIKE ${searchPattern} ESCAPE '\\'`,
        sql`EXISTS (
          SELECT 1
            FROM ${partiesTable} supplier
           WHERE supplier.id = ${invoicesTable.supplierPartyId}
             AND supplier.legal_name ILIKE ${searchPattern} ESCAPE '\\'
        )`,
      )
    : undefined;
  const query = getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.buyerPartyId, buyerPartyId),
        inArray(invoicesTable.status, [...BUYER_VISIBLE_STATUSES]),
        options?.invoiceId
          ? eq(invoicesTable.id, options.invoiceId)
          : undefined,
        options?.supplierPartyId
          ? eq(invoicesTable.supplierPartyId, options.supplierPartyId)
          : undefined,
        statePredicate,
        searchPredicate,
      ),
    )
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id));
  const invoices = options
    ? await query.limit(options.limit).offset(options.offset)
    : await query;
  if (invoices.length === 0) return [];
  const ids = invoices.map((i) => i.id);
  const stamps = await getDb()
    .select({ invoiceId: stampRecordsTable.invoiceId })
    .from(stampRecordsTable)
    .where(inArray(stampRecordsTable.invoiceId, ids));
  const stampedIds = new Set(stamps.map((s) => s.invoiceId));
  const confirmations = await getDb()
    .select({
      invoiceId: confirmationsTable.invoiceId,
      state: confirmationsTable.state,
      createdAt: confirmationsTable.createdAt,
    })
    .from(confirmationsTable)
    .where(inArray(confirmationsTable.invoiceId, ids))
    .orderBy(desc(confirmationsTable.createdAt), desc(confirmationsTable.id));
  const latestByInvoice = new Map<string, { state: string; createdAt: Date }>();
  for (const c of confirmations) {
    if (!latestByInvoice.has(c.invoiceId)) {
      latestByInvoice.set(c.invoiceId, {
        state: c.state,
        createdAt: c.createdAt,
      });
    }
  }
  return invoices.map((invoice) => {
    const latest = latestByInvoice.get(invoice.id);
    return {
      invoice,
      stamped: stampedIds.has(invoice.id),
      eligible: isPresentableAsEligible(invoice.status),
      latestConfirmation: latest?.state ?? null,
      latestConfirmationAt: latest?.createdAt ?? null,
    };
  });
}

export async function summarizeBuyerBook(
  buyerPartyId: string,
): Promise<BuyerInvoiceSummary> {
  const latestState = sql<string>`COALESCE((
    SELECT c.state::text
      FROM confirmations c
     WHERE c.invoice_id = ${invoicesTable.id}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 1
  ), 'none')`;
  const rows = await getDb()
    .select({
      state: latestState,
      invoiceCount: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${invoicesTable.grandTotal}), 0)::text`,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.buyerPartyId, buyerPartyId),
        inArray(invoicesTable.status, [...BUYER_VISIBLE_STATUSES]),
      ),
    )
    .groupBy(latestState);

  const counts: BuyerInvoiceSummary["counts"] = {
    none: 0,
    requested: 0,
    confirmed: 0,
    queried: 0,
    rejected: 0,
  };
  let awaitingTotal = "0.00";
  for (const row of rows) {
    if (row.state in counts) {
      counts[row.state as BuyerConfirmationState] = row.invoiceCount;
      if (row.state === "requested") awaitingTotal = row.amount;
    }
  }
  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    awaitingTotal,
    counts,
  };
}

function groupBySupplier(book: InvoiceFacts[]): Map<string, InvoiceFacts[]> {
  const groups = new Map<string, InvoiceFacts[]>();
  for (const fact of book) {
    const key = fact.invoice.supplierPartyId;
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  return groups;
}

// One supplier's summary from its facts — the SINGLE aggregation both the
// exposure breakdown (BR-01) and the supplier drill-down (contract 0.42.0)
// run, so the two surfaces can never disagree on the numbers. VAT on a
// purchase is protected when the supplier invoice is stamped AND still
// lifecycle-eligible (CORE-09 — a cancelled or credited stamped invoice is
// exposure, not protection).
function supplierSummaryOf(
  supplierPartyId: string,
  facts: InvoiceFacts[],
  supplier:
    | { legalName: string; tin: string | null; tinValidated: boolean }
    | undefined,
): SupplierSummary {
  const agg = {
    invoiceCount: 0,
    stampedCount: 0,
    eligibleCount: 0,
    totalAmount: 0,
    vatProtected: 0,
    vatAtRisk: 0,
  };
  for (const fact of facts) {
    const vat = Number(fact.invoice.vatTotal);
    const protectedVat = fact.stamped && fact.eligible;
    agg.invoiceCount++;
    if (fact.stamped) agg.stampedCount++;
    if (fact.stamped && fact.eligible) agg.eligibleCount++;
    agg.totalAmount += Number(fact.invoice.grandTotal);
    if (protectedVat) agg.vatProtected += vat;
    else agg.vatAtRisk += vat;
  }
  return {
    supplierPartyId,
    supplierName: supplier?.legalName ?? "Unknown supplier",
    supplierTin: supplier?.tin ?? null,
    tinValidated: supplier?.tinValidated ?? false,
    invoiceCount: agg.invoiceCount,
    stampedCount: agg.stampedCount,
    eligibleCount: agg.eligibleCount,
    totalAmount: money(agg.totalAmount),
    vatProtected: money(agg.vatProtected),
    vatAtRisk: money(agg.vatAtRisk),
  };
}

// Input-VAT exposure (BR-01): VAT on a buyer's purchase is protected when the
// supplier invoice is stamped AND still lifecycle-eligible (CORE-09 — a
// cancelled or credited stamped invoice is exposure, not protection).
export async function computeExposure(
  buyerPartyId: string,
): Promise<ExposureComputation> {
  const book = await loadBuyerBook(buyerPartyId);
  const supplierIds = [...new Set(book.map((f) => f.invoice.supplierPartyId))];
  const suppliers = supplierIds.length
    ? await getDb()
        .select({
          id: partiesTable.id,
          legalName: partiesTable.legalName,
          tin: partiesTable.tin,
          tinValidated: partiesTable.tinValidated,
        })
        .from(partiesTable)
        .where(inArray(partiesTable.id, supplierIds))
    : [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const breakdown: SupplierSummary[] = [...groupBySupplier(book).entries()].map(
    ([supplierPartyId, facts]) =>
      supplierSummaryOf(
        supplierPartyId,
        facts,
        supplierById.get(supplierPartyId),
      ),
  );
  breakdown.sort((a, b) => Number(b.vatAtRisk) - Number(a.vatAtRisk));

  return {
    buyerPartyId,
    supplierCount: breakdown.length,
    invoiceCount: book.length,
    protectedVat: money(
      breakdown.reduce((s, r) => s + Number(r.vatProtected), 0),
    ),
    atRiskVat: money(breakdown.reduce((s, r) => s + Number(r.vatAtRisk), 0)),
    breakdown,
    computedAt: new Date(),
  };
}

async function persistSnapshot(exposure: ExposureComputation): Promise<void> {
  await getDb()
    .insert(buyerExposureSnapshotsTable)
    .values({
      buyerPartyId: exposure.buyerPartyId,
      supplierCount: exposure.supplierCount,
      invoiceCount: exposure.invoiceCount,
      protectedVat: exposure.protectedVat,
      atRiskVat: exposure.atRiskVat,
      breakdown: exposure.breakdown as unknown as Record<string, unknown>[],
      computedAt: exposure.computedAt,
    });
}

// Serve the latest snapshot; recompute inline when stale or absent so the
// "refreshed at least daily" promise holds even across worker downtime.
export async function getOrRefreshExposure(
  buyerPartyId: string,
): Promise<ExposureComputation> {
  const [latest] = await getDb()
    .select()
    .from(buyerExposureSnapshotsTable)
    .where(eq(buyerExposureSnapshotsTable.buyerPartyId, buyerPartyId))
    .orderBy(desc(buyerExposureSnapshotsTable.computedAt))
    .limit(1);
  if (
    latest &&
    Date.now() - latest.computedAt.getTime() < SNAPSHOT_MAX_AGE_MS
  ) {
    return {
      buyerPartyId,
      supplierCount: latest.supplierCount,
      invoiceCount: latest.invoiceCount,
      protectedVat: latest.protectedVat,
      atRiskVat: latest.atRiskVat,
      breakdown: (latest.breakdown ?? []) as unknown as SupplierSummary[],
      computedAt: latest.computedAt,
    };
  }
  const exposure = await computeExposure(buyerPartyId);
  await persistSnapshot(exposure);
  return exposure;
}

// Worker sweep (pipeline interval): refresh a snapshot for every buyer party
// with at least one invoice whose latest snapshot is older than the window.
// A no-op while buyer_rails is dark (PL-02).
async function refreshBuyerExposures(): Promise<number> {
  return runInBypassContext(async () => {
    if (!(await isFeatureEnabled("buyer_rails", null))) return 0;
    const buyers = await getDb()
      .selectDistinct({ buyerPartyId: invoicesTable.buyerPartyId })
      .from(invoicesTable);
    let refreshed = 0;
    for (const { buyerPartyId } of buyers) {
      const [latest] = await getDb()
        .select({ computedAt: buyerExposureSnapshotsTable.computedAt })
        .from(buyerExposureSnapshotsTable)
        .where(eq(buyerExposureSnapshotsTable.buyerPartyId, buyerPartyId))
        .orderBy(desc(buyerExposureSnapshotsTable.computedAt))
        .limit(1);
      if (
        latest &&
        Date.now() - latest.computedAt.getTime() < SNAPSHOT_MAX_AGE_MS
      ) {
        continue;
      }
      const exposure = await computeExposure(buyerPartyId);
      await persistSnapshot(exposure);
      refreshed++;
    }
    return refreshed;
  });
}

// Register the daily-refresh sweep with the worker at import time.
registerSweep(refreshBuyerExposures);

export interface ScoreboardEntry {
  rank: number;
  supplierPartyId: string;
  supplierName: string;
  complianceScore: number;
  stampedRate: number;
  confirmedRate: number;
  invoiceCount: number;
  confirmedCount: number;
  outstandingCount: number;
  queriedCount: number;
  vatAtRisk: string;
}

// Supplier compliance scoreboard (BR-05): compliance (stamp validity) and
// confirmation dimensions combined into one ranked, exportable view.
export async function computeScoreboard(
  buyerPartyId: string,
): Promise<ScoreboardEntry[]> {
  const book = await loadBuyerBook(buyerPartyId);
  const supplierIds = [...new Set(book.map((f) => f.invoice.supplierPartyId))];
  const suppliers = supplierIds.length
    ? await getDb()
        .select({ id: partiesTable.id, legalName: partiesTable.legalName })
        .from(partiesTable)
        .where(inArray(partiesTable.id, supplierIds))
    : [];
  const nameById = new Map(suppliers.map((s) => [s.id, s.legalName]));

  const perSupplier = new Map<
    string,
    {
      invoiceCount: number;
      stampedEligible: number;
      confirmed: number;
      outstanding: number;
      queried: number;
      vatAtRisk: number;
    }
  >();
  for (const fact of book) {
    const key = fact.invoice.supplierPartyId;
    const agg = perSupplier.get(key) ?? {
      invoiceCount: 0,
      stampedEligible: 0,
      confirmed: 0,
      outstanding: 0,
      queried: 0,
      vatAtRisk: 0,
    };
    agg.invoiceCount++;
    if (fact.stamped && fact.eligible) agg.stampedEligible++;
    else agg.vatAtRisk += Number(fact.invoice.vatTotal);
    if (fact.latestConfirmation === "confirmed") agg.confirmed++;
    else if (fact.latestConfirmation === "requested") agg.outstanding++;
    else if (
      fact.latestConfirmation === "queried" ||
      fact.latestConfirmation === "rejected"
    ) {
      agg.queried++;
    }
    perSupplier.set(key, agg);
  }

  const entries = [...perSupplier.entries()].map(([supplierPartyId, agg]) => {
    const stampedRate = agg.invoiceCount
      ? agg.stampedEligible / agg.invoiceCount
      : 0;
    const confirmedRate = agg.invoiceCount
      ? agg.confirmed / agg.invoiceCount
      : 0;
    // Stamp validity is weighted above confirmation progress: an unstamped
    // invoice is a statutory exposure, an unconfirmed one a workflow gap.
    const complianceScore =
      Math.round((0.6 * stampedRate + 0.4 * confirmedRate) * 1000) / 1000;
    return {
      rank: 0,
      supplierPartyId,
      supplierName: nameById.get(supplierPartyId) ?? "Unknown supplier",
      complianceScore,
      stampedRate: Math.round(stampedRate * 1000) / 1000,
      confirmedRate: Math.round(confirmedRate * 1000) / 1000,
      invoiceCount: agg.invoiceCount,
      confirmedCount: agg.confirmed,
      outstandingCount: agg.outstanding,
      queriedCount: agg.queried,
      vatAtRisk: money(agg.vatAtRisk),
    };
  });
  entries.sort(
    (a, b) =>
      b.complianceScore - a.complianceScore ||
      b.invoiceCount - a.invoiceCount ||
      a.supplierName.localeCompare(b.supplierName),
  );
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });
  return entries;
}

// The buyer-portal invoice row (contract BuyerInvoice) — ONE serializer so the
// invoice list, the pending-confirmations CSV and the supplier drill-down can
// never drift apart on what a buyer sees of an invoice.
export interface BuyerInvoiceView {
  id: string;
  invoiceNumber: string;
  supplierPartyId: string;
  supplierName: string;
  status: string;
  grandTotal: string;
  vatTotal: string;
  issueDate: string;
  dueDate: string | null;
  confirmationState: string;
  stampValid: boolean;
  eligible: boolean;
}

export function buyerInvoiceView(
  fact: InvoiceFacts,
  supplierName: string | undefined,
): BuyerInvoiceView {
  return {
    id: fact.invoice.id,
    invoiceNumber: fact.invoice.invoiceNumber,
    supplierPartyId: fact.invoice.supplierPartyId,
    supplierName: supplierName ?? "Unknown supplier",
    status: fact.invoice.status,
    grandTotal: fact.invoice.grandTotal,
    vatTotal: fact.invoice.vatTotal,
    issueDate: fact.invoice.issueDate,
    dueDate: fact.invoice.dueDate,
    confirmationState: fact.latestConfirmation ?? "none",
    stampValid: fact.stamped,
    eligible: fact.stamped && fact.eligible,
  };
}

export interface SupplierDetailView {
  supplier: SupplierSummary;
  invoices: BuyerInvoiceView[];
}

// Supplier drill-down (contract 0.42.0): one supplier's aggregate — computed
// by the same supplierSummaryOf the exposure breakdown runs — plus the
// buyer's invoices from that supplier. Scoped to the caller's buyer party by
// construction (only invoices addressed to buyerPartyId are loaded), so a
// supplier that has never invoiced this buyer — including another buyer's
// supplier, or one whose only invoices are still private drafts (CORE-02) —
// is a plain 404, indistinguishable from a supplier that does not exist.
export async function supplierDetail(
  buyerPartyId: string,
  supplierPartyId: string,
): Promise<SupplierDetailView> {
  const detailCap = 500;
  const facts = await loadBuyerBook(buyerPartyId, {
    limit: detailCap + 1,
    offset: 0,
    supplierPartyId,
  });
  if (facts.length === 0) {
    throw new DomainError("NOT_FOUND", "Supplier not found", 404);
  }
  if (facts.length > detailCap) {
    throw new DomainError(
      "RESULT_TOO_LARGE",
      `Supplier detail exceeds ${detailCap} invoices; narrow the requested dataset`,
      413,
    );
  }
  const [supplier] = await getDb()
    .select({
      legalName: partiesTable.legalName,
      tin: partiesTable.tin,
      tinValidated: partiesTable.tinValidated,
    })
    .from(partiesTable)
    .where(eq(partiesTable.id, supplierPartyId))
    .limit(1);
  return {
    supplier: supplierSummaryOf(supplierPartyId, facts, supplier),
    invoices: facts.map((f) => buyerInvoiceView(f, supplier?.legalName)),
  };
}

// ---------------------------------------------------------------------------
// Bulk confirmation response (contract 0.42.0). A buyer clears up to 50
// awaiting invoices in one action while the per-invoice machinery stays
// EXACTLY what a single response runs. confirmInvoiceForBuyer below is a
// deliberate re-implementation of the respond branch of the single
// confirmation write — whose domain rules now live in
// modules/invoice/confirmations.ts recordConfirmation (the invoices.ts
// split extracted them from the route) — mirrored rather than shared,
// because the bulk path repurposes several refusals as per-item skip
// reasons; if recordConfirmation's semantics change, change this helper
// too. The mirrored rules, piece by piece:
//   - route fork: load the invoice, 404 unknown, assertBuyerPartyAccess;
//   - BUYER_PARTY_MISMATCH — structurally impossible here (bulk carries no
//     body buyerPartyId; the row below is always written with the invoice's
//     own buyer);
//   - TIN gate: an unvalidated buyer party never enters the workflow
//     (TIN_NOT_VALIDATED, the 422 becomes a skip reason);
//   - the latest lineage row must be an open `requested` (NO_OPEN_REQUEST)
//     — a duplicate id later in the same batch lands here too, because the
//     first occurrence closed the lane;
//   - METHOD_REQUIRED — the bulk contract requires `method` (minLength 1),
//     so every item carries the caller's method;
//   - CORE-09: a cancelled/credited invoice collects no confirmation
//     (INVOICE_NOT_ELIGIBLE);
//   - the append-only row, confirmingUserId captured (BR-02);
//   - compare-and-set status transition + lifecycle ledger row;
//   - the invoice.confirmation audit event.
// (The single path's request-side buyer NUDGE is respond-only-irrelevant:
// neither path sends anything on a response.)
// ---------------------------------------------------------------------------

async function confirmInvoiceForBuyer(
  principal: Principal,
  invoiceId: string,
  method: string,
  noSetOff: boolean,
): Promise<void> {
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertBuyerPartyAccess(principal, invoice.buyerPartyId);
  const [buyer] = await getDb()
    .select({ tinValidated: partiesTable.tinValidated })
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.buyerPartyId))
    .limit(1);
  if (!buyer?.tinValidated) {
    throw new DomainError(
      "TIN_NOT_VALIDATED",
      "Buyer TIN must be validated before entering the confirmation workflow",
      422,
    );
  }
  const [latest] = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, invoiceId))
    .orderBy(desc(confirmationsTable.createdAt))
    .limit(1);
  if (!latest || latest.state !== "requested") {
    throw new DomainError(
      "NO_OPEN_REQUEST",
      "A confirmation response requires an open request",
      409,
    );
  }
  if (!isPresentableAsEligible(invoice.status)) {
    throw new DomainError(
      "INVOICE_NOT_ELIGIBLE",
      `Invoice is ${invoice.status}; the confirmation request is void`,
      409,
    );
  }
  const [row] = await getDb()
    .insert(confirmationsTable)
    .values({
      invoiceId,
      buyerPartyId: invoice.buyerPartyId,
      state: "confirmed",
      method,
      noSetOff,
      note: null,
      confirmingUserId: principal.userId,
    })
    .returning();
  if (canTransition(invoice.status, "confirmed")) {
    // Compare-and-set: if the invoice moved concurrently (cancel/credit), the
    // confirmation row stands as lineage but the status transition is skipped.
    const [moved] = await getDb()
      .update(invoicesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(invoicesTable.id, invoiceId),
          eq(invoicesTable.status, invoice.status),
        ),
      )
      .returning({ id: invoicesTable.id });
    if (moved) {
      await recordTransition({
        invoiceId: invoice.id,
        firmId: invoice.firmId,
        fromStatus: invoice.status,
        toStatus: "confirmed",
        actorId: principal.userId,
        actorRole: principal.role,
      });
    }
  }
  await appendAudit({
    actorId: principal.userId,
    firmId: invoice.firmId,
    action: "invoice.confirmation",
    entityType: "confirmation",
    entityId: row.id,
    after: { state: row.state, method: row.method, noSetOff: row.noSetOff },
  });
}

export interface BulkConfirmItem {
  invoiceId: string;
  status: "confirmed" | "skipped";
  reason: string | null;
}

export interface BulkConfirmResult {
  confirmed: number;
  skipped: number;
  items: BulkConfirmItem[];
}

export const BULK_CONFIRM_MAX = 50;

// Confirm a batch, one savepoint per item (the bulk-approve idiom,
// modules/clerk/bulk-approve.ts): each item runs in a nested transaction
// under the caller's request transaction, so a refused or failed item rolls
// back ONLY its own writes and the batch keeps going — skips are reported
// per item, never silent, and one bad row can never abort (or half-commit)
// its neighbours. Nothing here is automatic: the buyer chose every id and
// the method is the caller's own statement of how it confirmed.
export async function respondBulk(
  principal: Principal,
  invoiceIds: string[],
  method: string,
  noSetOff: boolean,
): Promise<BulkConfirmResult> {
  // The contract caps the batch at 50; restated here because the service is
  // callable without the route's schema in front of it.
  if (invoiceIds.length > BULK_CONFIRM_MAX) {
    throw new DomainError(
      "BATCH_TOO_LARGE",
      `At most ${BULK_CONFIRM_MAX} invoices can be confirmed in one batch`,
      400,
    );
  }
  const items: BulkConfirmItem[] = [];
  for (const invoiceId of invoiceIds) {
    try {
      await getDb().transaction(async () => {
        await confirmInvoiceForBuyer(principal, invoiceId, method, noSetOff);
      });
      items.push({ invoiceId, status: "confirmed", reason: null });
    } catch (err) {
      // A domain refusal (cross-buyer, TIN gate, closed lane, dead invoice)
      // marks THIS row skipped with the refusal's own message; anything else
      // is reported generically — raw internals are a log concern, not a
      // response payload.
      items.push({
        invoiceId,
        status: "skipped",
        reason:
          err instanceof DomainError
            ? err.message
            : "Confirmation failed unexpectedly",
      });
    }
  }
  const confirmed = items.filter((i) => i.status === "confirmed").length;
  return { confirmed, skipped: items.length - confirmed, items };
}
