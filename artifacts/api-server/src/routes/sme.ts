import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  partiesTable,
  escalationsTable,
  alertPreferencesTable,
  type Invoice,
  type B2cReportBatch,
} from "@workspace/db";
import {
  GetDashboardSummaryQueryParams,
  GetDashboardSummaryResponse,
  ImportInvoicesBody,
  ImportInvoicesResponse,
  GetComplianceCalendarQueryParams,
  GetComplianceCalendarResponse,
  GetAlertPreferencesParams,
  GetAlertPreferencesResponse,
  UpdateAlertPreferencesParams,
  UpdateAlertPreferencesBody,
  UpdateAlertPreferencesResponse,
  SendTestAlertParams,
  SendTestAlertResponse,
  ListEscalationsParams,
  ListEscalationsResponse,
  EscalateInvoiceParams,
  EscalateInvoiceBody,
  EscalateInvoiceResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  assertSameTenant,
  assertPartyAccess,
  tenantFirmId,
} from "../modules/auth/rbac";
import { createDraft, bulkCreateDrafts, getInvoiceWithLines } from "../modules/invoice/service";
import { isFeatureEnabled } from "../modules/flags/flags";
import { openBatchesFor } from "../modules/b2c/service";
import { sendMessage } from "../modules/messaging/messaging";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";

const router: IRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
// SMEs must submit an issued invoice for stamping within this window; past it the
// invoice is on penalty watch (SME-05).
const SUBMISSION_WINDOW_DAYS = 7;

function daysUntil(target: Date, from: Date): number {
  return Math.floor((target.getTime() - from.getTime()) / DAY_MS);
}

type Deadline = {
  id: string;
  clientPartyId: string;
  kind: "vat_return" | "b2c_report" | "invoice_submission" | "penalty_watch";
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
): Deadline[] {
  const now = new Date();
  const deadlines: Deadline[] = [];

  // Monthly VAT return + remittance: due the 21st of the following month.
  const vatDue = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 21),
  );
  const vatDays = daysUntil(vatDue, now);
  deadlines.push({
    id: `vat-${vatDue.toISOString().slice(0, 10)}`,
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
    const b2cDue = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 10),
    );
    const b2cDays = daysUntil(b2cDue, now);
    deadlines.push({
      id: `b2c-${b2cDue.toISOString().slice(0, 10)}`,
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
    if (inv.status !== "draft" && inv.status !== "validated") continue;
    const submitBy = new Date(new Date(inv.issueDate).getTime());
    submitBy.setUTCDate(submitBy.getUTCDate() + SUBMISSION_WINDOW_DAYS);
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

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const clientPartyId = query.data.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const invoices = await loadClientInvoices(clientPartyId, tenant);

  const isUnsubmitted = (s: Invoice["status"]) =>
    s === "draft" || s === "validated";
  const isStamped = (s: Invoice["status"]) =>
    s === "stamped" || s === "confirmed" || s === "settled";

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

  const b2cBatches = (await isFeatureEnabled("b2c_reporting", req.principal.firmId))
    ? await openBatchesFor(clientPartyId, tenant)
    : null;
  const deadlines = computeDeadlines(clientPartyId, invoices, b2cBatches);
  const overdue = deadlines.filter((d) => d.status === "overdue");
  const upcoming = deadlines.filter((d) => d.status !== "met");
  const nextDeadline = upcoming[0] ?? null;
  const atRiskCount = overdue.length + failedCount;
  const penaltyRisk =
    overdue.length > 0 || failedCount > 1
      ? "high"
      : failedCount > 0 || deadlines.some((d) => d.status === "due_soon")
        ? "medium"
        : "low";

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

router.get("/compliance/calendar", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = GetComplianceCalendarQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const clientPartyId = query.data.clientPartyId;
  await assertPartyAccess(req.principal, clientPartyId);
  const tenant = tenantFirmId(req.principal);
  const invoices = await loadClientInvoices(clientPartyId, tenant);
  const b2cBatches = (await isFeatureEnabled("b2c_reporting", req.principal.firmId))
    ? await openBatchesFor(clientPartyId, tenant)
    : null;
  const deadlines = computeDeadlines(clientPartyId, invoices, b2cBatches);
  res.json(GetComplianceCalendarResponse.parse(deadlines));
});

// Mandatory-field validation for a single spreadsheet row (SME-02). Mirrors the
// guided single-invoice rules so bulk import gives the same catalogue guidance.
function validateImportRow(
  row: Record<string, unknown>,
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const req = (field: string, label: string) => {
    if (!str(row[field])) errors.push({ field, message: `${label} is required` });
  };
  req("invoiceNumber", "Invoice number");
  req("buyerName", "Buyer name");
  req("buyerTin", "Buyer TIN");
  req("issueDate", "Issue date");
  req("description", "Line description");

  const issueDate = str(row.issueDate);
  if (issueDate && Number.isNaN(new Date(issueDate).getTime())) {
    errors.push({ field: "issueDate", message: "Issue date is not a valid date" });
  }
  const num = (field: string, label: string, min: number) => {
    const raw = str(row[field]);
    if (!raw) {
      errors.push({ field, message: `${label} is required` });
      return;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
      errors.push({ field, message: `${label} must be a number` });
    } else if (n < min) {
      errors.push({ field, message: `${label} must be at least ${min}` });
    }
  };
  num("quantity", "Quantity", 0.0001);
  num("unitPrice", "Unit price", 0);
  const vat = str(row.vatRate);
  if (!vat) {
    errors.push({ field: "vatRate", message: "VAT rate is required" });
  } else {
    const n = Number(vat);
    if (Number.isNaN(n) || n < 0 || n > 1) {
      errors.push({
        field: "vatRate",
        message: "VAT rate must be a fraction between 0 and 1 (e.g. 0.075)",
      });
    }
  }
  return errors;
}

router.post("/invoices/import", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const parsed = ImportInvoicesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { clientPartyId, rows } = parsed.data;
  const commit = parsed.data.commit ?? false;
  await assertPartyAccess(req.principal, clientPartyId);
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }

  const results: {
    rowNumber: number;
    status: "valid" | "invalid" | "created";
    invoiceId: string | null;
    invoiceNumber: string | null;
    errors: { field: string; message: string }[];
  }[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let createdCount = 0;

  // NFR-03: large committed imports take the bulk path — chunked multi-row
  // inserts instead of ~6 statements per row — so a 5,000-row import completes
  // well inside the request-transaction budget.
  const BULK_THRESHOLD = 100;
  if (commit && rows.length > BULK_THRESHOLD) {
    const valid: typeof rows = [];
    for (const row of rows) {
      const errors = validateImportRow(row as Record<string, unknown>);
      if (errors.length > 0) {
        invalidCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          status: "invalid",
          invoiceId: null,
          invoiceNumber: row.invoiceNumber ?? null,
          errors,
        });
        continue;
      }
      valid.push(row);
    }
    // Resolve every buyer TIN in one pass; create missing buyers in one insert.
    const tins = [...new Set(valid.map((r) => String(r.buyerTin)))];
    const existingBuyers = tins.length
      ? await getDb()
          .select({ id: partiesTable.id, tin: partiesTable.tin })
          .from(partiesTable)
          .where(inArray(partiesTable.tin, tins))
      : [];
    const buyerByTin = new Map(existingBuyers.map((b) => [b.tin, b.id]));
    const missing = valid.filter((r) => !buyerByTin.has(String(r.buyerTin)));
    const missingByTin = new Map(
      missing.map((r) => [String(r.buyerTin), String(r.buyerName)]),
    );
    if (missingByTin.size > 0) {
      const createdBuyers = await getDb()
        .insert(partiesTable)
        .values(
          [...missingByTin.entries()].map(([tin, legalName]) => ({
            type: "buyer" as const,
            legalName,
            tin,
            countryCode: "NG",
          })),
        )
        .returning({ id: partiesTable.id, tin: partiesTable.tin });
      for (const b of createdBuyers) buyerByTin.set(b.tin, b.id);
    }
    const created = await bulkCreateDrafts(
      firmId,
      valid.map((row) => ({
        rowNumber: row.rowNumber,
        supplierPartyId: clientPartyId,
        buyerPartyId: buyerByTin.get(String(row.buyerTin))!,
        invoiceNumber: String(row.invoiceNumber),
        issueDate: String(row.issueDate),
        dueDate: row.dueDate ? String(row.dueDate) : null,
        currency: row.currency ? String(row.currency) : "NGN",
        line: {
          description: String(row.description),
          quantity: String(row.quantity),
          unitPrice: String(row.unitPrice),
          vatRate: String(row.vatRate),
        },
      })),
      req.principal.userId,
    );
    for (const c of created) {
      createdCount += 1;
      validCount += 1;
      results.push({
        rowNumber: c.rowNumber,
        status: "created",
        invoiceId: c.invoiceId,
        invoiceNumber: c.invoiceNumber,
        errors: [],
      });
    }
    results.sort((a, b) => a.rowNumber - b.rowNumber);
    res.json(
      ImportInvoicesResponse.parse({
        total: rows.length,
        validCount,
        invalidCount,
        createdCount,
        committed: true,
        rows: results,
      }),
    );
    return;
  }

  for (const row of rows) {
    const errors = validateImportRow(row as Record<string, unknown>);
    if (errors.length > 0) {
      invalidCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        status: "invalid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors,
      });
      continue;
    }
    validCount += 1;
    if (!commit) {
      results.push({
        rowNumber: row.rowNumber,
        status: "valid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors: [],
      });
      continue;
    }

    // Commit a single row in isolation: a failure here (duplicate invoice
    // number, DB constraint, etc.) must be reported as a row-level error rather
    // than aborting the whole batch and leaving partial commits unreported.
    try {
      // Resolve (or create) the buyer party by TIN so repeated imports reuse the
      // same buyer record.
      const buyerTin = String(row.buyerTin);
      const [existingBuyer] = await getDb()
        .select()
        .from(partiesTable)
        .where(eq(partiesTable.tin, buyerTin))
        .limit(1);
      let buyerPartyId = existingBuyer?.id;
      if (!buyerPartyId) {
        const [buyer] = await getDb()
          .insert(partiesTable)
          .values({
            type: "buyer",
            legalName: String(row.buyerName),
            tin: buyerTin,
            countryCode: "NG",
          })
          .returning();
        buyerPartyId = buyer.id;
      }

      const { invoice } = await createDraft(
        {
          firmId,
          supplierPartyId: clientPartyId,
          buyerPartyId,
          invoiceNumber: String(row.invoiceNumber),
          issueDate: String(row.issueDate),
          dueDate: row.dueDate ? String(row.dueDate) : null,
          currency: row.currency ? String(row.currency) : "NGN",
          lines: [
            {
              description: String(row.description),
              quantity: String(row.quantity),
              unitPrice: String(row.unitPrice),
              vatRate: String(row.vatRate),
            },
          ],
        },
        req.principal.userId,
      );
      createdCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        status: "created",
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        errors: [],
      });
    } catch (err) {
      validCount -= 1;
      invalidCount += 1;
      const message =
        err instanceof DomainError
          ? err.message
          : "Could not save this invoice. Please review and retry.";
      results.push({
        rowNumber: row.rowNumber,
        status: "invalid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors: [{ field: "row", message }],
      });
    }
  }

  const result = {
    total: rows.length,
    validCount,
    invalidCount,
    createdCount,
    committed: commit,
    rows: results,
  };
  res.json(ImportInvoicesResponse.parse(result));
});

const DEFAULT_PREFS = {
  whatsappEnabled: true,
  smsEnabled: false,
  emailEnabled: true,
  whatsappTo: null,
  phone: null,
  email: null,
  deadlineAlerts: true,
  failureAlerts: true,
  penaltyAlerts: true,
};

router.get("/clients/:id/alert-preferences", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetAlertPreferencesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await assertPartyAccess(req.principal, params.data.id);
  const [row] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, params.data.id))
    .limit(1);
  const prefs = row ?? {
    clientPartyId: params.data.id,
    ...DEFAULT_PREFS,
    updatedAt: new Date(),
  };
  res.json(GetAlertPreferencesResponse.parse(prefs));
});

router.put("/clients/:id/alert-preferences", async (req, res): Promise<void> => {
  assertCan(req.principal, "messaging.send");
  const params = UpdateAlertPreferencesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAlertPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await assertPartyAccess(req.principal, params.data.id);
  const values = {
    clientPartyId: params.data.id,
    ...DEFAULT_PREFS,
    ...parsed.data,
  };
  const [row] = await getDb()
    .insert(alertPreferencesTable)
    .values(values)
    .onConflictDoUpdate({
      target: alertPreferencesTable.clientPartyId,
      set: { ...parsed.data, updatedAt: new Date() },
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: req.principal.firmId,
    action: "alert.preferences.update",
    entityType: "alert_preferences",
    entityId: params.data.id,
    after: parsed.data,
  });
  res.json(UpdateAlertPreferencesResponse.parse(row));
});

// Opaque, PII-free recipient reference derived from the party id (letters only,
// so it never trips the messaging data-boundary check).
function recipientRefFor(clientPartyId: string): string {
  const letters = clientPartyId.replace(/[^a-z]/gi, "").slice(0, 16);
  return `ref-${letters || "client"}`;
}

router.post("/clients/:id/alerts/test", async (req, res): Promise<void> => {
  assertCan(req.principal, "messaging.send");
  const params = SendTestAlertParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await assertPartyAccess(req.principal, params.data.id);
  const [row] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, params.data.id))
    .limit(1);
  const prefs = row ?? { ...DEFAULT_PREFS, clientPartyId: params.data.id };
  const recipientRef = recipientRefFor(params.data.id);

  const enabled: ("whatsapp" | "sms" | "email")[] = [];
  if (prefs.whatsappEnabled) enabled.push("whatsapp");
  if (prefs.smsEnabled) enabled.push("sms");
  if (prefs.emailEnabled) enabled.push("email");

  const results: {
    channel: "whatsapp" | "sms" | "email";
    messageId: string | null;
    status: "sent" | "delivered" | "failed" | "skipped";
    detail: string | null;
  }[] = [];
  for (const channel of enabled) {
    try {
      const message = await sendMessage({
        channel,
        recipientRef,
        templateKey: "deadline_reminder",
      });
      results.push({
        channel,
        messageId: message.providerMessageId ?? null,
        status: message.status === "failed" ? "failed" : "sent",
        detail:
          message.failoverFrom && message.failoverFrom !== channel
            ? `Delivered via ${message.channel} after ${message.failoverFrom} failed`
            : null,
      });
    } catch (err) {
      results.push({
        channel,
        messageId: null,
        status: "failed",
        detail: err instanceof Error ? err.message : "Send failed",
      });
    }
  }
  res.json(SendTestAlertResponse.parse(results));
});

async function loadInvoiceForTenant(
  req: { principal: import("../modules/auth/rbac").Principal },
  id: string,
): Promise<Invoice> {
  const bundle = await getInvoiceWithLines(id);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(req.principal, bundle.invoice.firmId);
  return bundle.invoice;
}

router.get("/invoices/:id/escalations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = ListEscalationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadInvoiceForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(escalationsTable)
    .where(eq(escalationsTable.invoiceId, params.data.id))
    .orderBy(desc(escalationsTable.createdAt));
  res.json(ListEscalationsResponse.parse(rows));
});

router.post("/invoices/:id/escalations", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = EscalateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = EscalateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const invoice = await loadInvoiceForTenant(req, params.data.id);
  const [row] = await getDb()
    .insert(escalationsTable)
    .values({
      invoiceId: invoice.id,
      firmId: invoice.firmId,
      clientPartyId: invoice.supplierPartyId,
      reason: parsed.data.reason,
      errorCode: parsed.data.errorCode ?? null,
      context: parsed.data.context ?? null,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.escalate",
    entityType: "escalation",
    entityId: row.id,
    after: { reason: row.reason, errorCode: row.errorCode },
  });
  res.status(201).json(EscalateInvoiceResponse.parse(row));
});

export default router;
