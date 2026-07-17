import { eq, sql } from "drizzle-orm";
import { getDb, chaseLogTable, invoicesTable } from "@workspace/db";
import { DomainError } from "../errors";
import {
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../auth/rbac";

// Chase ladder memory (round-14 idea #3). The chaser draft is one-shot;
// real collections escalate. This is the memory behind the ladder: one row
// per reminder the client actually SENT — logged when they copy the drafted
// text, never when a draft is merely generated. The platform still sends
// nothing; the log only remembers what the client did, so the next draft
// can be a follow-up instead of a first nudge, and the digest can say
// "4 invoices have had 2+ reminders and remain unpaid".

// The receivables definition, mirrored from receivables.ts — a reminder can
// only be logged against an invoice that is still chaseable.
const OUTSTANDING_STATUSES = new Set(["submitted", "stamped", "confirmed"]);

export interface ChaseHistory {
  invoiceId: string;
  count: number;
  lastAt: string | null;
}

export interface ChaseLogSummary extends ChaseHistory {
  // The reminder number the log row just recorded.
  stage: number;
}

// The reminder history for one invoice — consumed by the chaser draft (to
// pick the ladder stage) and returned to the UI after logging.
export async function chaseHistory(invoiceId: string): Promise<ChaseHistory> {
  const [row] = await getDb()
    .select({
      count: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${chaseLogTable.createdAt})::text`,
    })
    .from(chaseLogTable)
    .where(eq(chaseLogTable.invoiceId, invoiceId));
  return {
    invoiceId,
    count: Number(row?.count ?? 0),
    lastAt: row?.lastAt ?? null,
  };
}

// Record that a reminder was sent. Same tenancy posture as the chaser draft
// itself: firm match plus SEC-03 narrowing to the supplier party; only an
// outstanding receivable can be logged (a settled invoice takes no more
// reminders, whatever the UI raced against).
export async function recordChase(
  invoiceId: string,
  principal: Principal,
): Promise<ChaseLogSummary> {
  const [invoice] = await getDb()
    .select({
      id: invoicesTable.id,
      firmId: invoicesTable.firmId,
      supplierPartyId: invoicesTable.supplierPartyId,
      status: invoicesTable.status,
      kind: invoicesTable.kind,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(principal, invoice.firmId);
  assertClientPartyScope(principal, invoice.supplierPartyId);
  if (
    invoice.kind !== "invoice" ||
    !OUTSTANDING_STATUSES.has(invoice.status) ||
    invoice.firmId === null
  ) {
    throw new DomainError(
      "NOT_CHASEABLE",
      "Only an outstanding receivable (issued and not yet settled) can log a reminder",
      422,
    );
  }

  const before = await chaseHistory(invoiceId);
  const stage = before.count + 1;
  const [inserted] = await getDb()
    .insert(chaseLogTable)
    .values({
      firmId: invoice.firmId,
      invoiceId,
      stage,
      loggedByUserId: principal.userId,
    })
    .returning({ createdAt: chaseLogTable.createdAt });
  return {
    invoiceId,
    count: stage,
    lastAt: inserted?.createdAt
      ? new Date(inserted.createdAt as unknown as string | Date).toISOString()
      : null,
    stage,
  };
}

// Firm-wide digest fact: outstanding invoices that have already taken 2+
// reminders — money that polite nudging is not moving.
export async function countFirmChasedTwice(firmId: string): Promise<number> {
  const [row] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE i.kind = 'invoice'
        AND i.status IN ('submitted', 'stamped', 'confirmed')
        AND i.firm_id = ${firmId}
        AND (SELECT COUNT(*) FROM chase_log c WHERE c.invoice_id = i.id) >= 2
    `)
  ).rows;
  return Number(row?.n ?? 0);
}
