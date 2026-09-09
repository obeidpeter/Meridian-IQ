import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
  STAMPED_STATE,
  SUBMIT_BY_INSTANT,
  UNSUBMITTED_STATE,
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
type UnsubmittedRow = Pick<
  Invoice,
  "id" | "invoiceNumber" | "issueDate" | "status"
>;

function computeDeadlines(
  clientPartyId: string,
  invoices: UnsubmittedRow[],
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
      description:
        "Aggregated business-to-consumer sales report for the period.",
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

// Bounded reads (R98): the client's invoice book is never loaded into JS.
// The counts and totals are ONE aggregate (the SQL twins of isUnsubmitted /
// isStamped / submissionDeadline keep the numbers identical to the deadline
// list's), the activity feed is the newest eight rows, and the per-invoice
// deadline list is the unsubmitted subset only — oldest issue date first, so
// the most overdue come first — capped like the bills list it sits beside.
// The exact overdue / due-soon counts come from the aggregate, so a client
// past the cap still sees honest headline numbers.
const UNSUBMITTED_DEADLINE_CAP = 500;

type BookSummary = {
  total: number;
  unsubmittedCount: number;
  pendingCount: number;
  stampedCount: number;
  failedCount: number;
  cancelledCount: number;
  unsubmittedValue: string;
  stampedValue: string;
  overdueSubmissions: number;
  dueSoonSubmissions: number;
};

async function loadBookSummary(
  clientPartyId: string,
  tenant: string | null,
): Promise<BookSummary> {
  const tenantClause = tenant ? sql`AND i.firm_id = ${tenant}` : sql``;
  const [row] = (
    await getDb().execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE ${UNSUBMITTED_STATE})::int AS unsubmitted_count,
        count(*) FILTER (WHERE i.status = 'submitted')::int AS pending_count,
        count(*) FILTER (WHERE ${STAMPED_STATE})::int AS stamped_count,
        count(*) FILTER (WHERE i.status = 'failed')::int AS failed_count,
        count(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled_count,
        round(coalesce(sum(i.grand_total) FILTER (WHERE ${UNSUBMITTED_STATE}), 0), 2)::text
          AS unsubmitted_value,
        round(coalesce(sum(i.grand_total) FILTER (WHERE ${STAMPED_STATE}), 0), 2)::text
          AS stamped_value,
        count(*) FILTER (WHERE ${UNSUBMITTED_STATE} AND ${SUBMIT_BY_INSTANT} < now())::int
          AS overdue_submissions,
        count(*) FILTER (
          WHERE ${UNSUBMITTED_STATE}
            AND ${SUBMIT_BY_INSTANT} >= now()
            AND ${SUBMIT_BY_INSTANT} < now() + interval '4 days'
        )::int AS due_soon_submissions
      FROM invoices i
      WHERE i.supplier_party_id = ${clientPartyId} ${tenantClause}
    `)
  ).rows as {
    total: number;
    unsubmitted_count: number;
    pending_count: number;
    stamped_count: number;
    failed_count: number;
    cancelled_count: number;
    unsubmitted_value: string;
    stamped_value: string;
    overdue_submissions: number;
    due_soon_submissions: number;
  }[];
  return {
    total: row?.total ?? 0,
    unsubmittedCount: row?.unsubmitted_count ?? 0,
    pendingCount: row?.pending_count ?? 0,
    stampedCount: row?.stamped_count ?? 0,
    failedCount: row?.failed_count ?? 0,
    cancelledCount: row?.cancelled_count ?? 0,
    unsubmittedValue: row?.unsubmitted_value ?? "0.00",
    stampedValue: row?.stamped_value ?? "0.00",
    overdueSubmissions: row?.overdue_submissions ?? 0,
    dueSoonSubmissions: row?.due_soon_submissions ?? 0,
  };
}

async function loadUnsubmittedInvoices(
  clientPartyId: string,
  tenant: string | null,
): Promise<UnsubmittedRow[]> {
  const conditions = [
    eq(invoicesTable.supplierPartyId, clientPartyId),
    inArray(invoicesTable.status, ["draft", "validated"]),
  ];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  return getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      issueDate: invoicesTable.issueDate,
      status: invoicesTable.status,
    })
    .from(invoicesTable)
    .where(and(...conditions))
    .orderBy(asc(invoicesTable.issueDate), asc(invoicesTable.id))
    .limit(UNSUBMITTED_DEADLINE_CAP);
}

// The shared fetch behind the two deadline surfaces (dashboard summary and
// compliance calendar): the client's unsubmitted invoices, the live B2C
// batch clocks when the R2 module is on (null while it is dark —
// computeDeadlines then emits the legacy placeholder), and the
// due-date-bearing bills, folded through computeDeadlines.
async function loadDeadlines(
  clientPartyId: string,
  tenant: string | null,
  firmId: string | null,
): Promise<Deadline[]> {
  const unsubmitted = await loadUnsubmittedInvoices(clientPartyId, tenant);
  const b2cBatches = (await isFeatureEnabled("b2c_reporting", firmId))
    ? await openBatchesFor(clientPartyId, tenant)
    : null;
  const bills = await listBillDeadlines(clientPartyId, tenant);
  return computeDeadlines(clientPartyId, unsubmitted, b2cBatches, bills);
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetDashboardSummaryQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const book = await loadBookSummary(clientPartyId, tenant);
  const deadlines = await loadDeadlines(
    clientPartyId,
    tenant,
    req.principal.firmId,
  );
  const { failedCount } = book;

  // Deadline headline numbers: the per-invoice share comes from the
  // aggregate (exact past the deadline-list cap), the rest from the
  // non-invoice deadlines (VAT, B2C clocks, bills) the list carries.
  const other = deadlines.filter(
    (d) => d.kind !== "invoice_submission" && d.kind !== "penalty_watch",
  );
  const overdueCount =
    book.overdueSubmissions +
    other.filter((d) => d.status === "overdue").length;
  const upcomingCount =
    book.unsubmittedCount + other.filter((d) => d.status !== "met").length;
  const nextDeadline = deadlines.find((d) => d.status !== "met") ?? null;
  const atRiskCount = overdueCount + failedCount;
  const dueSoon =
    book.dueSoonSubmissions > 0 || other.some((d) => d.status === "due_soon");
  const penaltyRisk = computePenaltyRisk(overdueCount, failedCount, dueSoon);

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

  const recentConditions = [eq(invoicesTable.supplierPartyId, clientPartyId)];
  if (tenant) recentConditions.push(eq(invoicesTable.firmId, tenant));
  const recent = await getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
      updatedAt: invoicesTable.updatedAt,
    })
    .from(invoicesTable)
    .where(and(...recentConditions))
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id))
    .limit(8);
  const invoiceActivity = recent.map((inv) => ({
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
    totalInvoices: book.total,
    draftCount: book.unsubmittedCount,
    pendingCount: book.pendingCount,
    stampedCount: book.stampedCount,
    failedCount,
    cancelledCount: book.cancelledCount,
    unsubmittedCount: book.unsubmittedCount,
    unsubmittedValue: book.unsubmittedValue,
    stampedValue: book.stampedValue,
    atRiskCount,
    upcomingDeadlineCount: upcomingCount,
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
router.get("/dashboard/receivables/export", async (req, res): Promise<void> => {
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
  sendCsvAttachment(res, `receivables-${lagosDateString()}.csv`, csv);
});

router.get("/compliance/calendar", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetComplianceCalendarQueryParams, req.query);
  const clientPartyId = query.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const deadlines = await loadDeadlines(
    clientPartyId,
    tenant,
    req.principal.firmId,
  );
  res.json(GetComplianceCalendarResponse.parse(deadlines));
});

export default router;
