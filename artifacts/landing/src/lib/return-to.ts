// Post-sign-in destination plumbing for the /login portal. Two producers put
// ?returnTo= on the portal URL: the app session guards (the page a session
// expired on, plus reason=expired) and the marketing page's workspace cards
// (the workspace the visitor asked to open). The portal honours it only when
// the value is a same-origin relative path inside a workspace the resolved
// role may open — anything else falls back to the role's default workspace.
// Pure functions, unit-tested in return-to.test.ts.

export interface WorkspaceTile {
  name: string;
  href: string;
  // null = public (no login). Otherwise the roles that can open it.
  allowedRoles: readonly string[] | null;
}

export interface WorkspaceTarget {
  href: string;
  label: string;
}

// Where each role starts after sign-in. The operator goes straight to the
// Compliance Desk work queue — that is the account's job, not the portfolio.
// firm_staff is resolved by defaultWorkspaceFor below: only client-pinned
// staff belong in the Compliance Workspace.
const DEFAULT_WORKSPACE: Readonly<Record<string, WorkspaceTarget>> = {
  operator: { href: "/console/operator-queue", label: "Operator queue" },
  bank_user: { href: "/console/data-room", label: "Bank Data Room" },
  firm_admin: { href: "/console/", label: "Accountant Console" },
  firm_staff: { href: "/app/", label: "Compliance Workspace" },
  client_user: { href: "/app/", label: "Compliance Workspace" },
  buyer_user: { href: "/buyer/", label: "Buyer Rails" },
  auditor: { href: "/console/audit", label: "Audit & evidence" },
};

/**
 * The workspace an account starts in after sign-in. Role decides — except
 * firm_staff, where the membership's client pin decides: staff pinned to a
 * client live in that client's Compliance Workspace, while unpinned staff have no
 * client scope (every SME page dead-ends on the "not scoped to a client
 * business" card), so they land on the firm's portfolio in the console.
 */
export function defaultWorkspaceFor(me: {
  role: string;
  clientPartyId?: string | null;
}): WorkspaceTarget | undefined {
  if (me.role === "firm_staff" && !me.clientPartyId) {
    return { href: "/console/", label: "Accountant Console" };
  }
  return DEFAULT_WORKSPACE[me.role];
}

/**
 * A usable returnTo is a same-origin RELATIVE path: it must start with a
 * single "/" and carry no scheme, no protocol-relative "//host", and no
 * backslash the URL parser could rewrite into one. Anything else is dropped.
 */
export function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) {
    return null;
  }
  return raw;
}

/**
 * The target a validated returnTo earns for this role: the sanitized path,
 * labelled by the workspace tile that owns its prefix — or null when the
 * path is unusable, matches no signed-in workspace, or belongs to a
 * workspace this role cannot open (the caller falls back to the default).
 */
export function resolveReturnTo(
  raw: string | null,
  role: string,
  apps: readonly WorkspaceTile[],
): WorkspaceTarget | null {
  const path = sanitizeReturnTo(raw);
  if (!path) return null;
  const app = apps.find(
    (tile) =>
      tile.allowedRoles !== null &&
      (path === tile.href ||
        path === tile.href.replace(/\/+$/, "") ||
        path.startsWith(tile.href)),
  );
  if (!app || !app.allowedRoles!.includes(role)) return null;
  return { href: path, label: app.name };
}
