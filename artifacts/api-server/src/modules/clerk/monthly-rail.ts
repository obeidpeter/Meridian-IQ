import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  alertPreferencesTable,
  clerkAdvisoryBriefsTable,
  clerkClientStatementsTable,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { fanOutAlert } from "../messaging/fan-out";
import { pointerEntityRef } from "../messaging/recipient-ref";
import type { PushTemplateKey } from "../push/push";

// The shared per-client monthly rail (round 54). The advisory-brief rail was
// built as "the statement rail verbatim" (round 50), and round 53 then had
// to apply the same privilege fix to both copies — the definition of a pair
// that must evolve together. The two mechanically identical pieces live
// here; each rider keeps everything that genuinely differs (flag keys, lock
// ids, month offsets, candidate filters, log lines), so a future rail fix
// lands once. This module deliberately imports NEITHER rider — only their
// tables — so it can never cycle.

// ---- The firm-pinned per-pair generation harness ---------------------------

// Explicit privilege for one sweep pair (round 53, one-homed round 54): the
// pair's generation runs in a firm-PINNED request context (meridian_app +
// app.firm_id), not on the raw pool — so it neither depends on the pool
// login's BYPASSRLS nor lets a compute bug cross firms mid-pass; RLS walls
// the whole pair. The transaction is idle while the provider phrases, so a
// finite in-transaction ceiling is pinned too: a deployment default SHORTER
// than provider latency would kill every pair mid-call (spend kept, row
// lost, pair re-offered — a burn loop bounded only by the firm budget), and
// no default at all would let a hung provider hold the connection forever.
// SET LOCAL dies with the transaction.
export async function runFirmPinnedPair<T>(
  firmId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runRequestContext({ bypass: false, firmId }, async () => {
    await getDb().execute(
      sql`SET LOCAL idle_in_transaction_session_timeout = '900s'`,
    );
    return fn();
  });
}

// ---- Claim-first delivery over the alert channels --------------------------

// Both rail tables share the delivery columns byte-for-byte (id, firm_id,
// client_party_id, delivered_at, created_at + the partial undelivered
// index). Query building below uses the statement table as the structural
// stand-in (drizzle's builders reject a union table type); at runtime every
// query runs against the table the rider actually passed, and `skipSend`
// receives that table's real rows, typed by the generic.
type AnyRailTable =
  | typeof clerkClientStatementsTable
  | typeof clerkAdvisoryBriefsTable;

export interface RailDeliveryOpts<T extends AnyRailTable> {
  table: T;
  templateKey: PushTemplateKey;
  entityType: string;
  // pointerEntityRef prefix — "stmt" / "brief".
  refPrefix: string;
  limit: number;
  // Claim the row but send nothing (the statement rail's quiet-month rule).
  // Absent = every claimed row is offered (the brief rail's deliberate
  // no-quiet-suppression choice).
  skipSend?: (row: T["$inferSelect"]) => boolean;
}

// Offer generated rows to the client's alert channels — claim-first CAS on
// delivered_at in its OWN committed transaction BEFORE any send leaves
// (at-most-once: a claimed row whose sends then fail is NOT re-offered —
// better a missed nudge than a double alert), consent-gated (CORE-03 —
// fanOutAlert sends nothing without a live layer-1 grant), pointer-only
// (SEC-12 — the message names no month, numbers or findings). The pending
// scan and the sends run on the ambient-free raw pool (autocommit — each
// message/push insert is individually durable); only the per-row claim
// opens a transaction, and it commits before any send: holding one bypass
// transaction across the whole pass meant a mid-pass failure rolled back
// every claim while pushes had already left the building. The claim is
// written even while messaging is dark (PL-02): turning the flag on later
// must not blast a backlog of old rows.
export async function deliverPendingClientAlerts<T extends AnyRailTable>(
  opts: RailDeliveryOpts<T>,
): Promise<number> {
  // The structural stand-in cast (see AnyRailTable above).
  const table = opts.table as typeof clerkClientStatementsTable;
  // Candidate rows, oldest first, so a backlog wider than one pass drains
  // in generation order; claimed rows drop out of the scan.
  const pending = await getDb()
    .select()
    .from(table)
    .where(isNull(table.deliveredAt))
    .orderBy(table.createdAt)
    .limit(opts.limit);
  if (pending.length === 0) return 0;

  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const row of pending) {
    const claim = await runInBypassContext(() =>
      getDb()
        .update(table)
        .set({ deliveredAt: new Date() })
        .where(and(eq(table.id, row.id), isNull(table.deliveredAt)))
        .returning({ id: table.id }),
    );
    if (claim.length === 0) continue; // another instance won this row
    claimed++;

    if (opts.skipSend?.(row as unknown as T["$inferSelect"])) continue;
    if (!messagingOn) continue;

    // Sends happen AFTER the claim committed, outside any open transaction:
    // a crash here loses at most the remaining channels of one row — never
    // a committed claim.
    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(eq(alertPreferencesTable.clientPartyId, row.clientPartyId))
      .limit(1);
    await fanOutAlert({
      prefs,
      clientPartyId: row.clientPartyId,
      firmId: row.firmId,
      templateKey: opts.templateKey,
      entityType: opts.entityType,
      entityId: pointerEntityRef(opts.refPrefix, row.id),
      // Same default as deadline reminders: with no prefs row, SMS is off.
      smsDefaultWhenNoPrefs: false,
    });
  }
  return claimed;
}
