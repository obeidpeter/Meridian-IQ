// Automatic deadline reminders (SME-05 closing the loop): the dashboard
// classifies unsubmitted invoices as due-soon/overdue passively; this sweep
// makes the alert active — the client is told through their enabled channels
// instead of having to look. Fan-out mirrors the B2C pre-breach alert:
// messaging rail (with failover) + push, pointer-only payloads (SEC-12).
import { and, inArray, lte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  alertPreferencesTable,
  deadlineReminderSendsTable,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { fanOutAlert } from "../messaging/fan-out";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { lagosDateString } from "../../lib/lagos-time";
import {
  SUBMISSION_WINDOW_DAYS,
  daysUntil,
  submissionDeadline,
} from "./compliance-window";

// Mirrors the dashboard's classification exactly (routes/sme.ts): due_soon at
// <= 3 days to the submission deadline, overdue past it. A reminder fires once
// per invoice per threshold — the deadline_reminder_sends ledger is the
// idempotency guard, not the sweep cadence.
export const DUE_SOON_DAYS = 3;

// An invoice this far past its deadline predates the reminder feature (or sat
// in a dead book): claim its slot silently instead of sending. Without this,
// enabling reminders on an existing deployment would blast a message for
// every stale draft ever left behind.
export const STALE_OVERDUE_DAYS = 60;

// Bound one pass; stragglers are picked up next tick (the sweep runs every
// minute, so a burst of due invoices drains within a few passes).
const BATCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the number of slots CLAIMED this pass (sends may be fewer: opt-outs,
// dark flag and stale invoices claim silently). Zero means the book is fully
// processed — callers can drain by looping until then.
//
// Sweep-only: must run OUTSIDE any request context, mirroring the digest
// delivery shape (deliverFirmDigests). The candidate read, the prefs read and
// the sends run on the ambient-free raw pool (autocommit — each message/push
// insert is individually durable); only the per-row CLAIM opens a
// transaction, and it COMMITS before any send leaves. Holding one bypass
// transaction across the whole pass — claims, prefs reads AND the provider
// sends — meant a mid-pass failure rolled back every claim and message row
// while real-provider sends had already left the building, and sibling
// instances blocked on the row locks for the duration.
export async function sweepDeadlineReminders(
  now = new Date(),
): Promise<number> {
  // SQL prefilter: daysUntil(issueDate + WINDOW, now) <= DUE_SOON_DAYS implies
  // issueDate < now - (WINDOW - DUE_SOON_DAYS) days. Date-only granularity may
  // admit a boundary row; the exact JS classification below settles it.
  // Oldest first: the most overdue invoices are processed ahead of the merely
  // due-soon when a backlog exceeds one pass.
  const cutoff = lagosDateString(
    new Date(now.getTime() - (SUBMISSION_WINDOW_DAYS - DUE_SOON_DAYS) * DAY_MS),
  );
  // Exclude invoices already claimed at their CURRENT threshold — without
  // this, a backlog wider than the limit keeps returning the same processed
  // rows and newer due invoices never enter the window. The CASE mirrors the
  // JS classification: past the deadline instant (Lagos midnight after the
  // window, matching submissionDeadline) means overdue.
  const unclaimedAtThreshold = sql`NOT EXISTS (
    SELECT 1 FROM deadline_reminder_sends s
    WHERE s.invoice_id = ${invoicesTable.id}
      AND s.kind::text = CASE
        WHEN ((${invoicesTable.issueDate}::date
              + ${SUBMISSION_WINDOW_DAYS} * interval '1 day')::timestamp
              AT TIME ZONE 'Africa/Lagos') < ${now}
        THEN 'overdue' ELSE 'due_soon' END
  )`;
  const candidates = await getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        inArray(invoicesTable.status, ["draft", "validated"]),
        lte(invoicesTable.issueDate, cutoff),
        unclaimedAtThreshold,
      ),
    )
    .orderBy(invoicesTable.issueDate)
    .limit(BATCH_LIMIT * 2);

  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const inv of candidates) {
    if (claimed >= BATCH_LIMIT) break;
    const days = daysUntil(submissionDeadline(inv.issueDate), now);
    if (days > DUE_SOON_DAYS) continue; // boundary row still upcoming
    const kind = days < 0 ? ("overdue" as const) : ("due_soon" as const);

    // Claim the (invoice, kind) slot first, in its OWN short committed
    // transaction: the unique index makes the insert the atomic cross-
    // instance once-only gate, and committing it BEFORE any send leaves is
    // the at-most-once trade — a claimed reminder whose sends then fail is
    // NOT re-offered (better a missed nudge than a double alert; the
    // dashboard still shows the invoice as due/overdue either way).
    const claim = await runInBypassContext(() =>
      getDb()
        .insert(deadlineReminderSendsTable)
        .values({
          invoiceId: inv.id,
          clientPartyId: inv.supplierPartyId,
          firmId: inv.firmId,
          kind,
        })
        .onConflictDoNothing()
        .returning({ id: deadlineReminderSendsTable.id }),
    );
    if (claim.length === 0) continue; // already reminded at this threshold
    claimed++;

    // The claim row is written even while messaging is dark (PL-02), and
    // ancient stale drafts claim silently: turning the flag on later must not
    // blast reminders for a backlog nobody is acting on.
    if (!messagingOn) continue;
    if (days < -STALE_OVERDUE_DAYS) continue;

    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(sql`${alertPreferencesTable.clientPartyId} = ${inv.supplierPartyId}`)
      .limit(1);
    // No prefs row means the table defaults apply: whatsapp/email/push on,
    // sms off, deadline alerts on.
    if (prefs && !prefs.deadlineAlerts) continue;
    // Sends happen strictly AFTER the claim committed, outside any open
    // transaction: each message/push write is an autocommit insert, so a
    // failure here loses at most this reminder's remaining channels — never
    // a committed claim (fanOutAlert absorbs per-channel failures; they land
    // in the messages ledger).
    await fanOutAlert({
      prefs,
      clientPartyId: inv.supplierPartyId,
      firmId: inv.firmId,
      templateKey: "deadline_reminder",
      entityType: "invoice",
      entityId: pointerEntityRef("inv", inv.id),
      // Historical default preserved: with no prefs row, deadline reminders
      // do NOT send SMS (unlike the B2C pre-breach alert).
      smsDefaultWhenNoPrefs: false,
    });
  }
  return claimed;
}
