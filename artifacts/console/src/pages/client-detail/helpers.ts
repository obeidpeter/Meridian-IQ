import type { OffboardClientResult } from "@workspace/api-client-react";
import { localDayIso } from "@workspace/format/notice-copy";
import { errorStatus, serverErrorMessage } from "@/lib/errors";

// The client page's pure kernels (R126 split): view gating, the export and
// offboard copy, and the compliance-pack naming. The unit suite pins them
// through the page's index module.

export const CLIENT_VIEWS = [
  "today",
  "invoices",
  "money",
  "compliance",
  "clerk",
  "setup",
] as const;
export type ClientView = (typeof CLIENT_VIEWS)[number];

/**
 * Launch-profile gates per view (PL-02, mirroring layout.tsx's
 * NavLink.feature): absent from Me.features means the view's API surfaces
 * answer 404, so the tab hides rather than opening a dead pane. A view
 * listing several keys shows when ANY is lit; each member card then mounts
 * only under its own key.
 */
export const CLIENT_VIEW_FEATURES: Partial<Record<ClientView, string[]>> = {
  money: ["collection_accounts", "statutory_desks"],
  compliance: ["statutory_desks", "client_reports"],
  clerk: ["clerk_ai"],
};

export function visibleClientViews(
  features: ReadonlySet<string>,
): ClientView[] {
  return CLIENT_VIEWS.filter((v) => {
    const required = CLIENT_VIEW_FEATURES[v];
    return !required || required.some((f) => features.has(f));
  });
}

// ---- Export & offboarding helpers -------------------------------------------
// The data-subject export saves the server's bundle verbatim as JSON; the
// offboard flow is firm_admin-only with a typed-name confirm the SERVER
// verifies (the dialog only requires non-blank — the authority stays with
// the 400 CONFIRM_MISMATCH).

export function exportFilename(id: string): string {
  return `client-data-${id}.json`;
}

export function canOffboardClient(role: string | undefined): boolean {
  return role === "firm_admin";
}

/** The dialog's own gate: something typed. Exact matching is the server's. */
export function offboardConfirmReady(input: string): boolean {
  return input.trim().length > 0;
}

/** What offboarding does, in the words the confirm dialog shows. */
export const OFFBOARD_EXPLANATION =
  "Statutory invoice records are retained. The client's sign-in access is removed and this engagement is archived. Contact details are cleared when yours was their last engagement.";

/**
 * Inline note for a failed offboard. The endpoint's one 400 is the
 * CONFIRM_MISMATCH guard, so say that in words; anything else relays the
 * server's own message with a plain fallback.
 */
export function offboardErrorNote(err: unknown): string {
  if (errorStatus(err) === 400) {
    return "That doesn't match this client's legal name — type it exactly as shown.";
  }
  return serverErrorMessage(err) ?? "Could not offboard the client. Try again.";
}

/** Success-toast summary of what the offboard actually did. */
export function offboardSummary(result: OffboardClientResult): string {
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  const parts = [
    n(
      result.engagementsArchived,
      "engagement archived",
      "engagements archived",
    ),
    n(result.membershipsRemoved, "sign-in removed", "sign-ins removed"),
  ];
  if (result.aliasesDeleted > 0) {
    parts.push(
      n(
        result.aliasesDeleted,
        "intake alias deleted",
        "intake aliases deleted",
      ),
    );
  }
  parts.push(
    result.contactCleared
      ? "contact details cleared"
      : "contact details kept (still engaged elsewhere)",
  );
  return parts.join(" · ");
}

// ---- Compliance pack --------------------------------------------------------
// The monthly client pack is one server-rendered PDF; the console only picks
// the month, names the saved file, and (separately) asks the platform to
// tell the client it is ready — that notification is consent-gated and
// pointer-only server-side.

/** Saved-file name for the monthly pack PDF: "compliance-pack-YYYY-MM.pdf". */
export function packPdfFilename(monthStart: string): string {
  const month = monthStart.slice(0, 7);
  return month ? `compliance-pack-${month}.pdf` : "compliance-pack.pdf";
}

/**
 * The current month's first day (YYYY-MM-01) — the pack picker's default.
 * Deliberately BROWSER-local (a picker default, not a statutory clock);
 * the formatting kernel is the shared localDayIso.
 */
export function currentMonthStart(now: Date = new Date()): string {
  return `${localDayIso(now).slice(0, 7)}-01`;
}
