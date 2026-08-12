import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  escalationsTable,
  type Invoice,
  type B2cReportBatch,
} from "@workspace/db";
import {
  GetDashboardSummaryQueryParams,
  GetDashboardSummaryResponse,
  GetReceivablesSummaryQueryParams,
  GetCashflowOutlookQueryParams,
  GetCashflowOutlookResponse,
  GetNetCashPositionQueryParams,
  GetNetCashPositionResponse,
  GetChaseListQueryParams,
  GetChaseListResponse,
  GetReceivablesSummaryResponse,
  ExportReceivablesCsvQueryParams,
  GetComplianceCalendarQueryParams,
  GetComplianceCalendarResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  lagosDateString,
  lagosMidnight,
  lagosMidnightFor,
  lagosParts,
} from "../../lib/lagos-time";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { statutoryDueDay } from "../../modules/filings/statutory-calendar";
import {
  getReceivablesSummary,
  listOutstandingReceivables,
} from "../../modules/invoice/receivables";
import {
  computeCashflowOutlook,
  listChaseRows,
} from "../../modules/invoice/cashflow";
import { computeNetPosition } from "../../modules/invoice/net-position";
import {
  listBillDeadlines,
  type BillDeadlineRow,
} from "../../modules/invoice/payables";
import { sendCsvAttachment, toCsv } from "../../lib/csv";
import { isFeatureEnabled } from "../../modules/flags/flags";
import { openBatchesFor } from "../../modules/b2c/service";
import {
  daysUntil,
  isStamped,
  isUnsubmitted,
  penaltyRisk as computePenaltyRisk,
  submissionDeadline,
} from "../../modules/invoice/compliance-window";

const router: IRouter = Router();

type Deadline = {
  id: string;
  clientPartyId: string;
  kind:
    | "vat_return"
    | "b2c_report"
    | "invoice_submission"
    | "penalty_watch"
    | "bill_due";
  title: string;
  description: string | null;
  dueDate: string;
  status: "upcoming" | "due_soon" | "overdue" | "met";
  severity: "info" | "warning" | "critical";
  invoiceId: string | null;
};

// Deadlines are computed dynamically from the invoice book plus the statutory
// filing calendar — there is no deadlines table (SME-05). B2C clocks come from
// the live report batches when the R2 module is on (SME-08); while it is dark,
// the legacy consolidated-monthly placeholder row stands in.
function computeDeadlines(
  clientPartyId: string,
  invoices: Invoice[],
  b2cBatches: B2cReportBatch[] | null,
  bills: BillDeadlineRow[] = [],
): Deadline[] {
  const now = new Date();
  const deadlines: Deadline[] = [];

  // Monthly VAT return + remittance: due on the statutory-calendar day of
  // the following month (the Filing Desk one-home owns the number; round 41
  // folded this surface onto it). Statutory dates live on the LAGOS calendar
  // (lib/lagos-time.ts): both the "which month is it" question and the due
  // instant use local wall time. Deliberately ALWAYS next month — this
  // legacy deadline card predates the register and keeps its shape.
  const { year, monthIndex } = lagosParts(now);
  const vatDue = lagosMidnightFor(year, monthIndex + 1, statutoryDueDay("vat"));
  const vatDays = daysUntil(vatDue, now);
  deadlines.push({
    id: `vat-${lagosDateString(vatDue)}`,
    clientPartyId,
    kind: "vat_return",
    title: "VAT return filing",
    description: "Monthly VAT return and remittance to the FIRS.",
    dueDate: vatDue.toISOString(),
    status: vatDays <= 7 ? "due_soon" : "upcoming",
    severity: vatDays <= 7 ? "warning" : "info",
    invoiceId: null,
  });

  if (b2cBatches === null) {
    // Legacy placeholder: consolidated B2C report due the 10th of next month.
    const b2cDue = lagosMidnightFor(year, monthIndex + 1, 10);
    const b2cDays = daysUntil(b2cDue, now);
    deadlines.push({
      id: `b2c-${lagosDateString(b2cDue)}`,
      clientPartyId,
      kind: "b2c_report",
      title: "Consolidated B2C sales report",
      description: "Aggregated business-to-consumer sales report for the period.",
      dueDate: b2cDue.toISOString(),
      status: b2cDays <= 5 ? "due_soon" : "upcoming",
      severity: b2cDays <= 5 ? "warning" : "info",
      invoiceId: null,
    });
  } else {
    // SME-08: per-client 24-hour compliance clocks from open/breached batches.
    for (const batch of b2cBatches) {
      const breached = batch.status === "breached";
      const hoursLeft =
        (batch.deadlineAt.getTime() - now.getTime()) / (60 * 60 * 1000);
      deadlines.push({
        id: `b2c-batch-${batch.id}`,
        clientPartyId,
        kind: "b2c_report",
        title: breached
          ? `Overdue: B2C report (${batch.itemCount} sale${batch.itemCount === 1 ? "" : "s"})`
          : `B2C 24-hour report (${batch.itemCount} sale${batch.itemCount === 1 ? "" : "s"})`,
        description: breached
          ? "The 24-hour reporting window has passed; a daily penalty accrues until reported."
          : "Qualifying B2C sales above NGN 50,000 must be reported within 24 hours.",
        dueDate: batch.deadlineAt.toISOString(),
        status: breached ? "overdue" : hoursLeft <= 4 ? "due_soon" : "upcoming",
        severity: breached ? "critical" : hoursLeft <= 4 ? "warning" : "info",
        invoiceId: null,
      });
    }
  }

  // Per-invoice submission deadlines: unsubmitted invoices approaching or past
  // their submission window.
  for (const inv of invoices) {
    if (!isUnsubmitted(inv.status)) continue;
    const submitBy = submissionDeadline(inv.issueDate);
    const days = daysUntil(submitBy, now);
    const overdue = days < 0;
    deadlines.push({
      id: `submit-${inv.id}`,
      clientPartyId,
      kind: overdue ? "penalty_watch" : "invoice_submission",
      title: overdue
        ? `Overdue: submit invoice ${inv.invoiceNumber}`
        : `Submit invoice ${inv.invoiceNumber}`,
      description: overdue
        ? "Past the submission window — may attract penalties until stamped."
        : "Submit this invoice for stamping before the window closes.",
      dueDate: submitBy.toISOString(),
      status: overdue ? "overdue" : days <= 3 ? "due_soon" : "upcoming",
      severity: overdue ? "critical" : days <= 3 ? "warning" : "info",
      invoiceId: inv.id,
    });
  }

  // Supplier bills with a due date and no payment evidence (payables round,
  // kind=bill_due). The due instant is Lagos midnight AFTER the due day —
  // the whole due date is still payable, mirroring the payables summary
  // where due-today sits in the first due week, not in overdue. Severity
  // follows proximity exactly like invoice_submission.
  for (const bill of bills) {
    const payBy = lagosMidnight(bill.dueDate);
    payBy.setUTCDate(payBy.getUTCDate() + 1);
    const days = daysUntil(payBy, now);
    const overdue = days < 0;
    deadlines.push({
      id: `bill-${bill.invoiceId}`,
      clientPartyId,
      kind: "bill_due",
      title: overdue
        ? `Overdue: pay bill ${bill.invoiceNumber} (${bill.supplierName})`
        : `Pay bill ${bill.invoiceNumber} (${bill.supplierName})`,
      description: overdue
        ? "This supplier bill is past its due date with no payment recorded."
        : "A captured supplier bill falls due — schedule the payment.",
      dueDate: payBy.toISOString(),
      status: overdue ? "overdue" : days <= 3 ? "due_soon" : "upcoming",
      severity: overdue ? "critical" : days <= 3 ? "warning" : "info",
      invoiceId: bill.invoiceId,
    });
  }

  return deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

async function loadClientInvoices(
  clientPartyId: string,
  tenant: string | null,
): Promise<Invoice[]> {
  const conditions = [eq(invoicesTable.supplierPartyId, clientPartyId)];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  return getDb()
    .select()
    .from(invoicesTable)
    .where(and(...conditions))
    .orderBy(desc(invoicesTable.createdAt));
}

// The shared fetch behind the two deadline surfaces (dashboard summary and
// compliance calendar): the client's invoice book, the live B2C batch clocks
// when the R2 module is on (null while it is dark — computeDeadlines then
// emits the legacy placeholder), and the due-date-bearing bills, folded
// through computeDeadlines.
async function loadInvoicesAndDeadlines(
  clientPartyId: string,
  tenant: string | null,
  firmId: string | null,
): Promise<{ invoices: Invoice[]; deadlines: Deadline[] }> {
  const invoices = await loadClientInvoices(clientPartyId, tenant);
  const b2cBatches = (await isFeatureEnabled("b2c_reporting", firmId))
    ? await openBatchesFor(clientPartyId, tenant)
    : null;
  const bills = await listBillDeadlines(clientPartyId, tenant);
  const deadlines = computeDeadlines(clientPartyId, invoices, b2cBatches, bills);
  return { invoices, deadlines };
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetDashboardSummaryQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const { invoices, deadlines } = await loadInvoicesAndDeadlines(
    clientPartyId,
    tenant,
    req.principal.firmId,
  );

  let draftCount = 0;
  let pendingCount = 0;
  let stampedCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let unsubmittedValue = 0;
  let stampedValue = 0;
  for (const inv of invoices) {
    if (isUnsubmitted(inv.status)) {
      draftCount += 1;
      unsubmittedValue += Number(inv.grandTotal);
    } else if (inv.status === "submitted") {
      pendingCount += 1;
    } else if (isStamped(inv.status)) {
      stampedCount += 1;
      stampedValue += Number(inv.grandTotal);
    } else if (inv.status === "failed") {
      failedCount += 1;
    } else if (inv.status === "cancelled") {
      cancelledCount += 1;
    }
  }

  const overdue = deadlines.filter((d) => d.status === "overdue");
  const upcoming = deadlines.filter((d) => d.status !== "met");
  const nextDeadline = upcoming[0] ?? null;
  const atRiskCount = overdue.length + failedCount;
  const dueSoon = deadlines.some((d) => d.status === "due_soon");
  const penaltyRisk = computePenaltyRisk(overdue.length, failedCount, dueSoon);

  const activityKind = (s: Invoice["status"]) =>
    isUnsubmitted(s)
      ? "draft"
      : s === "submitted"
        ? "submitted"
        : isStamped(s)
          ? "stamped"
          : s === "failed"
            ? "failed"
            : "cancelled";

  const invoiceActivity = invoices.slice(0, 8).map((inv) => ({
    id: `inv-${inv.id}`,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    kind: activityKind(inv.status) as
      | "draft"
      | "submitted"
      | "stamped"
      | "failed"
      | "cancelled",
    label: `Invoice ${inv.invoiceNumber}`,
    status: inv.status,
    at: inv.updatedAt,
  }));

  const escalationConditions = [
    eq(escalationsTable.clientPartyId, clientPartyId),
  ];
  if (tenant) escalationConditions.push(eq(escalationsTable.firmId, tenant));
  const escalations = await getDb()
    .select()
    .from(escalationsTable)
    .where(and(...escalationConditions))
    .orderBy(desc(escalationsTable.createdAt))
    .limit(5);
  const escalationActivity = escalations.map((e) => ({
    id: `esc-${e.id}`,
    invoiceId: e.invoiceId,
    invoiceNumber: null as string | null,
    kind: "escalated" as const,
    label: `Escalation: ${e.reason}`,
    status: e.status,
    at: e.createdAt,
  }));

  const recentActivity = [...invoiceActivity, ...escalationActivity]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  const summary = {
    clientPartyId,
    totalInvoices: invoices.length,
    draftCount,
    pendingCount,
    stampedCount,
    failedCount,
    cancelledCount,
    unsubmittedCount: draftCount,
    unsubmittedValue: unsubmittedValue.toFixed(2),
    stampedValue: stampedValue.toFixed(2),
    atRiskCount,
    upcomingDeadlineCount: upcoming.length,
    nextDeadline,
    penaltyRisk,
    recentActivity,
  };
  res.json(GetDashboardSummaryResponse.parse(summary));
});

// Receivables aging: who owes this client what, and how old. Same access
// posture as the dashboard summary (party access + tenant scoping).
router.get("/dashboard/receivables", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetReceivablesSummaryQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const summary = await getReceivablesSummary(clientPartyId, tenant);
  res.json(GetReceivablesSummaryResponse.parse(summary));
});

// Cash-flow outlook (round-10 idea #1): outstanding receivables projected to
// their expected settlement dates (buyer rhythm > due date > default terms)
// and rolled into week buckets. Deterministic, nothing stored. Party access
// like the receivables summary, but DELIBERATELY stricter on tenancy:
// requireFirmScope 403s cross-tenant staff (behaviour mining is keyed on a
// real firmId; operators have the console rollup instead), where
// /dashboard/receivables lets them read the aging.
router.get("/dashboard/cashflow", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetCashflowOutlookQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const firmId = requireFirmScope(req.principal);
  const outlook = await computeCashflowOutlook(firmId, clientPartyId);
  res.json(GetCashflowOutlookResponse.parse(outlook));
});

// Net cash position (round-15 idea #2): the cash-flow outlook's projected
// inflows merged with the payables summary's committed outflows, per
// currency and week — both sides computed by their own existing functions,
// nothing recomputed. Same access posture as the outlook it extends.
router.get("/dashboard/net-position", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetNetCashPositionQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const firmId = requireFirmScope(req.principal);
  const position = await computeNetPosition(firmId, clientPartyId);
  res.json(GetNetCashPositionResponse.parse(position));
});

// Chase list (round-10 idea #2): the same projections, ranked by days beyond
// each buyer's OWN expected date — "late for them", not merely old.
router.get("/dashboard/chase-list", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetChaseListQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const firmId = requireFirmScope(req.principal);
  const rows = await listChaseRows(firmId, clientPartyId);
  res.json(GetChaseListResponse.parse(rows));
});

// CSV download of the per-invoice rows behind the aging summary — the file a
// collections call or external accountant works from. Same access posture.
router.get(
  "/dashboard/receivables/export",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    const query = parseOrThrow(ExportReceivablesCsvQueryParams, req.query);
    const clientPartyId = query.clientPartyId;
    await assertPartyAccess(req.principal, clientPartyId);
    const tenant = tenantFirmId(req.principal);
    const rows = await listOutstandingReceivables(clientPartyId, tenant);
    const csv = toCsv(
      [
        "invoiceNumber",
        "buyer",
        "issueDate",
        "dueDate",
        "ageDays",
        "bucket",
        "currency",
        "outstanding",
        "status",
      ],
      rows.map((r) => [
        r.invoiceNumber,
        r.buyerName,
        r.issueDate,
        r.dueDate,
        r.ageDays,
        r.bucket,
        r.currency,
        r.grandTotal,
        r.status,
      ]),
    );
    sendCsvAttachment(
      res,
      `receivables-${lagosDateString()}.csv`,
      csv,
    );
  },
);

router.get("/compliance/calendar", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetComplianceCalendarQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const { deadlines } = await loadInvoicesAndDeadlines(
    clientPartyId,
    tenant,
    req.principal.firmId,
  );
  res.json(GetComplianceCalendarResponse.parse(deadlines));
});

export default router;
