import {
  NoticeDecisionInputAuthority,
  NoticeDecisionInputNoticeType,
  NoticeDecisionInputTaxType,
  type ClerkCase,
  type ClerkCaseDecisionInputCategory,
} from "@workspace/api-client-react";

export const CATEGORIES: ClerkCaseDecisionInputCategory[] = [
  "b2b",
  "b2g",
  "b2c",
];

// The notice decision form's closed catalogues — the contract's own enums,
// never free text (grounding split: the model may suggest, only a catalogue
// value can be filed).
export const NOTICE_TYPES = Object.values(NoticeDecisionInputNoticeType);

export const AUTHORITIES = Object.values(NoticeDecisionInputAuthority);

export const TAX_TYPES = Object.values(NoticeDecisionInputTaxType);

// The two intake queues the workspace can show: invoice extraction cases
// (the default Capture tab) and tax-authority notice cases (Notice Desk).
// Question cases live on their own Ask page, not here.
export type QueueKind = "extraction" | "notice";

// The case queue loads in pages: with limit/offset present the server
// returns a bounded, newest-first slice instead of the full legacy list. A
// full page means there may be more — "Load more" appends the next one.
export const PAGE_SIZE = 50;

// The bulk-approve endpoint accepts at most 50 items per request (the
// contract's maxItems), so the fast-lane action sends at most one batch of
// the best-ranked ready cases.
export const BULK_APPROVE_MAX = 50;

// The queue's one-word status line under each intake title.
export const QUEUE_STATUS: Record<
  ClerkCase["status"],
  { label: string; cls: string }
> = {
  pending: { label: "Reading…", cls: "text-muted-foreground" },
  extracted: { label: "Ready for review", cls: "text-primary" },
  in_review: { label: "In review", cls: "text-primary" },
  approved: { label: "Approved", cls: "text-muted-foreground" },
  rejected: { label: "Rejected", cls: "text-muted-foreground" },
  escalated: { label: "Escalated", cls: "text-amber-700 dark:text-amber-400" },
  failed: { label: "Reading failed", cls: "text-destructive" },
};

export const OPEN_STATUSES = new Set<ClerkCase["status"]>([
  "pending",
  "extracted",
  "in_review",
]);

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// ---- Shared select blocks ---------------------------------------------------
// The firm select renders twice (invoice + notice decision forms) and the
// parties select three times (supplier/buyer/client); one component each so
// a display change never needs synchronized edits. Module-level on purpose —
// defining these inside ClerkWorkspace would remount the Radix selects every
// render.
