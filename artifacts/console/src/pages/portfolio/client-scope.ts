export const PORTFOLIO_VIEWS = [
  "today",
  "clients",
  "money",
  "compliance",
  "automation",
  "connections",
] as const;

export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number];

export type ClientRiskFilter = "all" | "high" | "medium" | "low";

export type ClientSort = "risk" | "name" | "unsubmitted" | "deadline";

// Per-staff client assignment (architecture.md D12): "mine" is the clients
// assigned to me PLUS every unassigned client (default-open); "all" is the
// whole book. A partition of the default view, never of access.
export type ClientScope = "mine" | "all";

export const CLIENT_SCOPES: readonly ClientScope[] = ["mine", "all"];

export function scopeClients<T extends { assignedUserIds?: string[] }>(
  clients: T[],
  scope: ClientScope,
  userId: string | undefined,
): T[] {
  if (scope === "all" || !userId) return clients;
  return clients.filter((c) => {
    const assigned = c.assignedUserIds ?? [];
    return assigned.length === 0 || assigned.includes(userId);
  });
}

// Staff with at least one assignment land on "mine"; everyone else (admins,
// staff nobody has assigned yet) sees the whole book, because "mine" would
// then equal "all" and the toggle would only confuse.
export function defaultClientScope(
  role: string | undefined,
  clients: { assignedUserIds?: string[] }[],
  userId: string | undefined,
): ClientScope {
  if (role !== "firm_staff" || !userId) return "all";
  return clients.some((c) => (c.assignedUserIds ?? []).includes(userId))
    ? "mine"
    : "all";
}

// URL-persisted (recognition over recall): back-navigation from a client
// returns to the exact filtered view, and a filtered book is shareable.
export const CLIENT_RISK_FILTERS: readonly ClientRiskFilter[] = [
  "all",
  "high",
  "medium",
  "low",
];

export const CLIENT_SORTS: readonly ClientSort[] = [
  "risk",
  "name",
  "unsubmitted",
  "deadline",
];
