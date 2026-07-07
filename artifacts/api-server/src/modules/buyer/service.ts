import { and, desc, eq, inArray } from "drizzle-orm";
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
import { isPresentableAsEligible } from "../invoice/lifecycle.ts";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";

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

interface InvoiceFacts {
  invoice: Invoice;
  stamped: boolean;
  eligible: boolean;
  latestConfirmation: string | null;
}

// Load the buyer's invoice book with stamp and confirmation facts resolved in
// three indexed selects (never per-invoice queries — the batch discipline of
// verifyStampBatch).
export async function loadBuyerBook(
  buyerPartyId: string,
): Promise<InvoiceFacts[]> {
  const invoices = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.buyerPartyId, buyerPartyId))
    .orderBy(desc(invoicesTable.createdAt));
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
    .orderBy(desc(confirmationsTable.createdAt));
  const latestByInvoice = new Map<string, string>();
  for (const c of confirmations) {
    if (!latestByInvoice.has(c.invoiceId)) {
      latestByInvoice.set(c.invoiceId, c.state);
    }
  }
  return invoices.map((invoice) => ({
    invoice,
    stamped: stampedIds.has(invoice.id),
    eligible: isPresentableAsEligible(invoice.status),
    latestConfirmation: latestByInvoice.get(invoice.id) ?? null,
  }));
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

  const perSupplier = new Map<
    string,
    {
      invoiceCount: number;
      stampedCount: number;
      eligibleCount: number;
      totalAmount: number;
      vatProtected: number;
      vatAtRisk: number;
    }
  >();
  for (const fact of book) {
    const key = fact.invoice.supplierPartyId;
    const agg = perSupplier.get(key) ?? {
      invoiceCount: 0,
      stampedCount: 0,
      eligibleCount: 0,
      totalAmount: 0,
      vatProtected: 0,
      vatAtRisk: 0,
    };
    const vat = Number(fact.invoice.vatTotal);
    const protectedVat = fact.stamped && fact.eligible;
    agg.invoiceCount++;
    if (fact.stamped) agg.stampedCount++;
    if (fact.stamped && fact.eligible) agg.eligibleCount++;
    agg.totalAmount += Number(fact.invoice.grandTotal);
    if (protectedVat) agg.vatProtected += vat;
    else agg.vatAtRisk += vat;
    perSupplier.set(key, agg);
  }

  const breakdown: SupplierSummary[] = [...perSupplier.entries()].map(
    ([supplierPartyId, agg]) => {
      const supplier = supplierById.get(supplierPartyId);
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
    },
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
  await getDb().insert(buyerExposureSnapshotsTable).values({
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
export async function refreshBuyerExposures(): Promise<number> {
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
