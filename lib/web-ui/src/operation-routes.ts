import { useCallback } from "react";

const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const importRun = new RegExp(`^/import\\?run=${UUID}$`);
const invoiceDetail = new RegExp(`^/invoices/${UUID}$`);
const invoiceDraft = new RegExp(`^/invoices/new\\?draft=${UUID}$`);
const clientDetail = new RegExp(
  `^/clients/${UUID}(?:\\?view=(?:setup|clerk))?$`,
);

function exactMatch(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

export function isImportOperationRoute(route: unknown): route is string {
  return route === "/import" || exactMatch(importRun, route);
}

// These are the source workspaces of the journal writers, not the workspace
// displaying their shared history. Unknown local routes are not navigation authority.
export function operationDestination(route: unknown): string | null {
  if (
    isImportOperationRoute(route) ||
    route === "/invoices" ||
    route === "/invoices/new" ||
    route === "/clerk" ||
    exactMatch(invoiceDetail, route) ||
    exactMatch(invoiceDraft, route)
  )
    return `/app${route}`;
  if (route === "/clients/import" || exactMatch(clientDetail, route))
    return `/console${route}`;
  return null;
}

const assignWorkspace = (destination: string) =>
  window.location.assign(destination);

export function useOperationNavigation(
  workspace: "app" | "console" | "buyer",
  navigate: (route: string) => void,
  assign: (destination: string) => void = assignWorkspace,
) {
  return useCallback(
    (route: string) => {
      const destination = operationDestination(route);
      if (!destination) return;
      if (destination.startsWith(`/${workspace}/`)) navigate(route);
      else assign(destination);
    },
    [workspace, navigate, assign],
  );
}
