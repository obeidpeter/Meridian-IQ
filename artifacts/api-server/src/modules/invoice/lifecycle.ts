import type { Invoice, InvoiceStatus } from "@workspace/db";
import { DomainError } from "../errors";

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

export const TERMINAL_STATUSES: InvoiceStatus[] = ["cancelled", "credited"];

export function canTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
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
