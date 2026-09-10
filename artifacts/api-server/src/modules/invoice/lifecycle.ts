import { and, eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  invoiceLifecycleEventsTable,
  type Invoice,
  type InvoiceStatus,
} from "@workspace/db";
// Explicit .ts extension: this module is imported by node --test suites, where
// native type stripping requires fully-specified relative imports.
import { DomainError } from "../errors.ts";

// Invoice lifecycle state machine (Appendix B, CORE-02, CORE-09).
// Drafts are mutable working state; every transition from `submitted` onward is
// recorded by appending events, and cancelled/credited are terminal so a
// cancelled stamped invoice can never be presented as eligible.
const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["validated", "cancelled"],
  validated: ["submitted", "draft", "cancelled"],
  submitted: ["stamped", "failed"],
  failed: ["submitted", "cancelled"],
  stamped: ["confirmed", "settled", "cancelled", "credited"],
  confirmed: ["settled", "credited", "cancelled"],
  settled: ["credited"],
  cancelled: [],
  credited: [],
};

// Statuses at or after which the invoice's financial content is immutable.
const IMMUTABLE_STATUSES: InvoiceStatus[] = [
  "submitted",
  "stamped",
  "confirmed",
  "settled",
  "cancelled",
  "credited",
];

const TERMINAL_STATUSES: InvoiceStatus[] = ["cancelled", "credited"];

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot move invoice from ${from} to ${to}`,
      409,
    );
  }
}

// Guards editing of invoice content: only drafts (and validated, which reverts
// to draft) may be mutated. Post-submission content is append-only.
export function assertMutableContent(invoice: Invoice): void {
  if (IMMUTABLE_STATUSES.includes(invoice.status)) {
    throw new DomainError(
      "IMMUTABLE_INVOICE",
      `Invoice ${invoice.id} is ${invoice.status}; content is immutable after submission`,
      409,
    );
  }
}

export function isTerminal(status: InvoiceStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// An invoice can only be presented as financeable/eligible if it is not
// cancelled or credited (CORE-09).
export function isPresentableAsEligible(status: InvoiceStatus): boolean {
  return !isTerminal(status);
}

// Guarded compare-and-set transition. The naive pattern — SELECT status, check
// assertTransition, then UPDATE by id — is a TOCTOU under READ COMMITTED: a
// concurrent cancel/credit can commit between the read and the write, and the
// unconditional UPDATE would resurrect a terminal invoice (e.g. overwrite
// `cancelled` with `settled`). This helper makes the expected from-status part
// of the UPDATE's WHERE clause; zero rows updated means the invoice moved under
// us and the transition is rejected with the same 409 a stale read would earn.
export async function applyTransition(
  invoiceId: string,
  from: InvoiceStatus,
  to: InvoiceStatus,
): Promise<Invoice> {
  assertTransition(from, to);
  const [row] = await getDb()
    .update(invoicesTable)
    .set({ status: to })
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.status, from)))
    .returning();
  if (!row) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Invoice ${invoiceId} is no longer ${from}; cannot move to ${to}`,
      409,
    );
  }
  return row;
}

export interface TransitionRecord {
  invoiceId: string;
  firmId: string;
  fromStatus: InvoiceStatus | null;
  toStatus: InvoiceStatus;
  actorId?: string | null;
  actorRole?: string | null;
  reason?: string | null;
}

// Append an immutable projection row for a status transition (CORE-02). Writes
// through getDb() so it participates in the ambient request/bypass transaction
// and is protected by the DB-level append-only trigger.
export async function recordTransition(
  record: TransitionRecord,
): Promise<void> {
  await getDb()
    .insert(invoiceLifecycleEventsTable)
    .values({
      invoiceId: record.invoiceId,
      firmId: record.firmId,
      fromStatus: record.fromStatus ?? null,
      toStatus: record.toStatus,
      actorId: record.actorId ?? null,
      actorRole: record.actorRole ?? null,
      reason: record.reason ?? null,
    });
}

// Skip-if-lost sibling of applyTransition (CORE-09): the same compare-and-set,
// but a lost race is a SKIP, not a 409 — the caller's evidence row (settlement
// event, confirmation) stands as lineage while a concurrently cancelled/credited
// invoice is never resurrected. Appends the lifecycle ledger row only when the
// CAS actually moved the invoice.
export async function tryTransition(
  invoice: Pick<Invoice, "id" | "status" | "firmId">,
  to: InvoiceStatus,
  actor: {
    actorId: string | null;
    actorRole: string | null;
    reason?: string | null;
  },
): Promise<boolean> {
  if (!canTransition(invoice.status, to)) return false;
  const [moved] = await getDb()
    .update(invoicesTable)
    .set({ status: to })
    .where(
      and(
        eq(invoicesTable.id, invoice.id),
        eq(invoicesTable.status, invoice.status),
      ),
    )
    .returning({ id: invoicesTable.id });
  if (!moved) return false;
  await recordTransition({
    invoiceId: invoice.id,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: to,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    reason: actor.reason ?? null,
  });
  return true;
}
