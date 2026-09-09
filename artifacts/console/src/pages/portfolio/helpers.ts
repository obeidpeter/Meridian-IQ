// The portfolio's many cards, grouped for scanning. Grouping is layout only —
// every card keeps its own gating (render-on-success / role checks) and its
// testids. The anchor row under the header jumps to each group.
export const PORTFOLIO_GROUPS = [
  { id: "clients", label: "Clients" },
  { id: "money", label: "Money" },
  { id: "compliance", label: "Compliance" },
  { id: "connections", label: "Connections & delivery" },
] as const;

export type PortfolioGroup = (typeof PORTFOLIO_GROUPS)[number];

// ---- Section occupancy -------------------------------------------------------
// "clients" and "money" always carry an unconditionally rendered card, but
// "compliance" and "connections" are composed ENTIRELY of self-gating
// render-on-success cards — if every member gates itself to null (older
// server build, feature dark, wrong role), the section would be a bare
// heading with a dead anchor chip. The page therefore observes the SAME
// queries the cards gate on (identical query keys, so react-query dedupes to
// one fetch) and renders a section + its chip only once at least one member
// card will actually show.

/** Mirrors ComplianceCalendarCard's own empty gate. */
export function calendarHasContent<
  T extends { days: unknown[]; overdue: { invoices: number } },
>(calendar: T | undefined): calendar is T {
  return (
    !!calendar && (calendar.days.length > 0 || calendar.overdue.invoices > 0)
  );
}

/** Mirrors RejectionPatternsCard's own empty gate. */
export function rejectionsHaveContent<T extends { rows: unknown[] }>(
  report: T | undefined,
): report is T {
  return !!report && report.rows.length > 0;
}

/**
 * The groups whose sections (and anchor chips) render, in scanning order.
 * Clients and Money are always occupied; Compliance and Connections come
 * from the lifted occupancy flags.
 */
export function visiblePortfolioGroups(occupied: {
  compliance: boolean;
  connections: boolean;
}): PortfolioGroup[] {
  return PORTFOLIO_GROUPS.filter((g) =>
    g.id === "compliance"
      ? occupied.compliance
      : g.id === "connections"
        ? occupied.connections
        : true,
  );
}

// ---- Getting-started checklist -----------------------------------------------
// First-run guidance: five steps from an empty book to the first stamped
// invoice, computed from data the page already holds (portfolio counts +
// the invitations list). Consent (step 3) is deliberately an info row — the
// client grants it themselves and the portfolio payload cannot see it, so
// the card never pretends to know.

export const GETTING_STARTED_DISMISS_KEY = "console.gettingStarted.dismissed";

export type GettingStartedStep = {
  id: "add-client" | "invite-owner" | "consent" | "first-invoice" | "stamping";
  label: string;
  /** "step" rows carry a checkbox; "info" rows are explanatory only. */
  kind: "step" | "info";
  done: boolean;
};

/** Sum of the book's invoices — ClientRisk.totalInvoices per client. */
export function portfolioInvoiceCount(
  clients: ReadonlyArray<{ totalInvoices: number }>,
): number {
  return clients.reduce((sum, c) => sum + c.totalInvoices, 0);
}

/**
 * Invoices that reached the rails: stamped (accepted) plus pending (submitted,
 * awaiting the verdict) — the two portfolio fields that prove a submission
 * happened.
 */
export function portfolioSubmittedCount(
  clients: ReadonlyArray<{ stampedCount: number; pendingCount: number }>,
): number {
  return clients.reduce((sum, c) => sum + c.stampedCount + c.pendingCount, 0);
}

/** Step 2's predicate: any client_user invitation, whatever its status. */
export function hasClientOwnerInvite(
  invitations: ReadonlyArray<{ role: string }> | undefined,
): boolean {
  return (invitations ?? []).some((i) => i.role === "client_user");
}

export function gettingStartedSteps(input: {
  clientCount: number;
  hasClientInvite: boolean;
  invoiceCount: number;
  submittedCount: number;
}): GettingStartedStep[] {
  return [
    {
      id: "add-client",
      label: "Add your first client",
      kind: "step",
      done: input.clientCount > 0,
    },
    {
      id: "invite-owner",
      label: "Invite the client's owner",
      kind: "step",
      done: input.hasClientInvite,
    },
    {
      id: "consent",
      label: "Client grants consent",
      kind: "info",
      done: false,
    },
    {
      id: "first-invoice",
      label: "Create the first invoice",
      kind: "step",
      done: input.invoiceCount > 0,
    },
    {
      id: "stamping",
      label: "Submit for stamping",
      kind: "step",
      done: input.submittedCount > 0,
    },
  ];
}

export function completedStepCount(steps: GettingStartedStep[]): number {
  return steps.filter((s) => s.kind === "step" && s.done).length;
}

/**
 * Show while the firm is still finding its feet: an empty book, or fewer
 * than 3 of the 4 checkable steps done — unless the partner dismissed it.
 */
export function shouldShowGettingStarted(args: {
  clientCount: number;
  steps: GettingStartedStep[];
  dismissed: boolean;
}): boolean {
  if (args.dismissed) return false;
  return args.clientCount === 0 || completedStepCount(args.steps) < 3;
}

// Storage access is parameterized so the helpers stay testable under node
// and a privacy mode that throws simply means "the card reappears".
export function readGettingStartedDismissed(
  storage: Pick<Storage, "getItem"> | null,
): boolean {
  try {
    return storage?.getItem(GETTING_STARTED_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGettingStartedDismissed(
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(GETTING_STARTED_DISMISS_KEY, "1");
  } catch {
    // Private mode — the dismissal simply doesn't stick.
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The /clients/import page needs BOTH the RBAC capability and the
 * white_label feature flag its API rides (routes/whitelabel.ts requireFlag)
 * — the same pair the nav's link gate checks (layout.tsx NavLink.feature),
 * so the header and empty-state Import buttons can never navigate into the
 * dead page the nav is hiding.
 */
export function canImportClients(
  me: { capabilities?: string[]; features?: string[] } | undefined,
): boolean {
  return (
    (me?.capabilities ?? []).includes("clients.import") &&
    (me?.features ?? []).includes("white_label")
  );
}
