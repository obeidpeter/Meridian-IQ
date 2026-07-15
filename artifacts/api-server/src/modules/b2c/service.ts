import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  b2cReportBatchesTable,
  b2cReportItemsTable,
  alertPreferencesTable,
  type B2cReportBatch,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { appendAudit } from "../audit/audit";
import { fanOutAlert } from "../messaging/fan-out";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";

// B2C reporting module (SME-08, C5). B2C transactions above NGN 50,000 must be
// reported within 24 hours of capture; late reporting attracts a daily penalty.
//
// The sweep (run from the pipeline worker) does three things each pass:
//   1. Collect qualifying invoices into per-client open batches. The batch
//      deadline anchors on the FIRST transaction's capture time + 24h, so every
//      item in the batch is inside its own statutory window when the batch is
//      reported by the deadline.
//   2. Fire the pre-breach alert when a batch is within the alert margin of its
//      deadline (>= 4h before breach), over the client's preferred channels,
//      pointer-only (SEC-12).
//   3. Mark open batches whose deadline has passed as breached.

export const B2C_THRESHOLD_NGN = 50_000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const ALERT_MARGIN_MS = 4 * 60 * 60 * 1000;

// A transaction qualifies once affirmed beyond draft; cancelled/credited
// records are corrections, not reportable sales.
const NON_QUALIFYING_STATUSES = ["draft", "cancelled", "credited"] as const;

// Collect qualifying B2C invoices that are not yet in any batch.
async function collectIntoBatches(): Promise<number> {
  const batched = getDb()
    .select({ invoiceId: b2cReportItemsTable.invoiceId })
    .from(b2cReportItemsTable);
  const qualifying = await getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.category, "b2c"),
        gt(invoicesTable.grandTotal, String(B2C_THRESHOLD_NGN)),
        notInArray(invoicesTable.status, [...NON_QUALIFYING_STATUSES]),
        notInArray(invoicesTable.id, batched),
      ),
    )
    .orderBy(asc(invoicesTable.createdAt));
  const now = new Date();
  let added = 0;
  for (const invoice of qualifying) {
    // One open batch per client; the first transaction anchors the clock. A
    // batch whose deadline has already passed never collects new sales — a
    // fresh sale has its own full 24-hour window and must open a new batch,
    // not inherit an expired clock (and an instant breach) from a stale one.
    const [open] = await getDb()
      .select()
      .from(b2cReportBatchesTable)
      .where(
        and(
          eq(b2cReportBatchesTable.clientPartyId, invoice.supplierPartyId),
          eq(b2cReportBatchesTable.firmId, invoice.firmId),
          eq(b2cReportBatchesTable.status, "open"),
          gt(b2cReportBatchesTable.deadlineAt, now),
        ),
      )
      .orderBy(asc(b2cReportBatchesTable.createdAt))
      .limit(1);
    let batchId: string;
    if (open) {
      batchId = open.id;
    } else {
      const windowStart = invoice.createdAt;
      const [batch] = await getDb()
        .insert(b2cReportBatchesTable)
        .values({
          firmId: invoice.firmId,
          clientPartyId: invoice.supplierPartyId,
          status: "open",
          windowStart,
          deadlineAt: new Date(windowStart.getTime() + WINDOW_MS),
        })
        .returning();
      batchId = batch.id;
    }
    const inserted = await getDb()
      .insert(b2cReportItemsTable)
      .values({
        batchId,
        invoiceId: invoice.id,
        amount: invoice.grandTotal,
      })
      .onConflictDoNothing({ target: b2cReportItemsTable.invoiceId })
      .returning({ id: b2cReportItemsTable.id });
    if (inserted.length > 0) {
      await getDb()
        .update(b2cReportBatchesTable)
        .set({
          itemCount: sql`${b2cReportBatchesTable.itemCount} + 1`,
          totalAmount: sql`${b2cReportBatchesTable.totalAmount} + ${invoice.grandTotal}::numeric`,
        })
        .where(eq(b2cReportBatchesTable.id, batchId));
      added++;
    }
  }
  return added;
}

// Fire pre-breach alerts for open batches inside the alert margin (SME-08:
// at least four hours before breach). Pointer-only payloads (SEC-12).
async function firePreBreachAlerts(now: Date): Promise<number> {
  const atRisk = await getDb()
    .select()
    .from(b2cReportBatchesTable)
    .where(
      and(
        eq(b2cReportBatchesTable.status, "open"),
        isNull(b2cReportBatchesTable.preBreachAlertAt),
        lte(
          b2cReportBatchesTable.deadlineAt,
          new Date(now.getTime() + ALERT_MARGIN_MS),
        ),
        gt(b2cReportBatchesTable.deadlineAt, now),
      ),
    );
  let alerted = 0;
  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  for (const batch of atRisk) {
    if (messagingOn) {
      const [prefs] = await getDb()
        .select()
        .from(alertPreferencesTable)
        .where(eq(alertPreferencesTable.clientPartyId, batch.clientPartyId))
        .limit(1);
      // Same PII-free entity ref on every channel so sends correlate.
      const entityId = `batch-${batch.id.replace(/[^a-z]/gi, "").slice(0, 6)}`;
      await fanOutAlert({
        prefs,
        clientPartyId: batch.clientPartyId,
        firmId: batch.firmId,
        templateKey: "b2c_window_alert",
        entityType: "b2c_report_batch",
        entityId,
        // Historical default preserved: with no prefs row, the B2C pre-breach
        // alert DOES send SMS (drifted from the deadline-reminder default).
        smsDefaultWhenNoPrefs: true,
      });
    }
    await getDb()
      .update(b2cReportBatchesTable)
      .set({ preBreachAlertAt: now })
      .where(eq(b2cReportBatchesTable.id, batch.id));
    await appendAudit({
      firmId: batch.firmId,
      action: "b2c.pre_breach_alert",
      entityType: "b2c_report_batch",
      entityId: batch.id,
      after: { deadlineAt: batch.deadlineAt.toISOString(), messagingOn },
    });
    alerted++;
  }
  return alerted;
}

async function markBreaches(now: Date): Promise<number> {
  const breached = await getDb()
    .update(b2cReportBatchesTable)
    .set({ status: "breached", breachedAt: now })
    .where(
      and(
        eq(b2cReportBatchesTable.status, "open"),
        lt(b2cReportBatchesTable.deadlineAt, now),
      ),
    )
    .returning({ id: b2cReportBatchesTable.id, firmId: b2cReportBatchesTable.firmId });
  for (const b of breached) {
    await appendAudit({
      firmId: b.firmId,
      action: "b2c.window_breached",
      entityType: "b2c_report_batch",
      entityId: b.id,
    });
  }
  return breached.length;
}

// One sweep pass; called on an interval by the pipeline worker. Bypass context:
// the sweep is trusted internal work spanning tenants. While the b2c_reporting
// flag is dark the sweep is a no-op (PL-02: dark features do nothing).
export async function sweepB2c(): Promise<{
  collected: number;
  alerted: number;
  breached: number;
}> {
  return runInBypassContext(async () => {
    if (!(await isFeatureEnabled("b2c_reporting", null))) {
      return { collected: 0, alerted: 0, breached: 0 };
    }
    const now = new Date();
    // Breaches are marked BEFORE collection so a sale captured after a
    // deadline never lands in the just-expired batch.
    const breached = await markBreaches(now);
    const collected = await collectIntoBatches();
    const alerted = await firePreBreachAlerts(now);
    return { collected, alerted, breached };
  });
}

// Register with the worker at import time.
registerSweep(sweepB2c);

// Mark a batch as reported. Reporting from `open` inside the window is the
// compliant path; a breached batch may still be reported late (the breach
// stands — the statutory penalty accrued) and keeps its breached status.
export async function submitBatch(
  batchId: string,
  actor: { userId: string; role: string },
): Promise<B2cReportBatch> {
  const [batch] = await getDb()
    .select()
    .from(b2cReportBatchesTable)
    .where(eq(b2cReportBatchesTable.id, batchId))
    .limit(1);
  if (!batch) throw new DomainError("NOT_FOUND", "Batch not found", 404);
  if (batch.reportedAt) {
    throw new DomainError("ALREADY_REPORTED", "Batch already reported", 409);
  }
  const now = new Date();
  // The statutory clock decides compliance, not the sweep's bookkeeping lag: a
  // submit after deadlineAt is a breach even if the sweep has not flipped the
  // batch yet.
  const insideWindow = batch.status === "open" && now <= batch.deadlineAt;
  const breachedLate = batch.status === "open" && !insideWindow;
  const [updated] = await getDb()
    .update(b2cReportBatchesTable)
    .set({
      status: insideWindow ? "reported" : "breached",
      reportedAt: now,
      reportedByUserId: actor.userId,
      ...(breachedLate ? { breachedAt: now } : {}),
    })
    .where(eq(b2cReportBatchesTable.id, batchId))
    .returning();
  await appendAudit({
    actorId: actor.userId,
    firmId: batch.firmId,
    action: "b2c.report_submitted",
    entityType: "b2c_report_batch",
    entityId: batchId,
    after: {
      status: updated.status,
      reportedAt: now.toISOString(),
      insideWindow,
    },
  });
  return updated;
}

// The per-client compliance clock feeding the calendar and dashboard (SME-08):
// the tightest open batch deadline, if any.
export async function openBatchesFor(
  clientPartyId: string,
  firmId: string | null,
): Promise<B2cReportBatch[]> {
  const conditions = [
    eq(b2cReportBatchesTable.clientPartyId, clientPartyId),
    inArray(b2cReportBatchesTable.status, ["open", "breached"]),
  ];
  if (firmId) conditions.push(eq(b2cReportBatchesTable.firmId, firmId));
  return getDb()
    .select()
    .from(b2cReportBatchesTable)
    .where(and(...conditions))
    .orderBy(asc(b2cReportBatchesTable.deadlineAt));
}
