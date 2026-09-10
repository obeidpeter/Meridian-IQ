// The /login portal (R126 split the 2,009-line App.tsx into this page
// surface, one module per panel, the two flow hooks and the tile catalogue).
// App.tsx keeps the lazy route boundaries and imports "@/portal"; auth.css
// stays imported from App.tsx so it remains inside the /login chunk.

import { useState } from "react";
import {
  useGetMe,
  logout,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { PortalHeader } from "@/components/portal-header";
import { AccessPortal, SessionSkeleton } from "./access-portal";
import { AppCard } from "./app-card";
import { SignInPanel } from "./sign-in-panel";
import { SignedInPanel } from "./signed-in-panel";
import { APPS, roleLabel, type AppTile, type Role } from "./tiles";

function focusEmailField() {
  const el = document.getElementById("email");
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

// The signed-in portal has no email field; "switch account" is the sign-out
// button in the signed-in panel.
function focusSignOutButton() {
  const el = document.getElementById("sign-out");
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

export function Portal() {
  const reason = new URLSearchParams(window.location.search).get("reason");
  const signedOut = reason === "local-signout" || reason === "signed-out";
  const [revoking, setRevoking] = useState(false);
  const [revocationConfirmed, setRevocationConfirmed] = useState(
    reason === "signed-out",
  );
  const {
    data: me,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false, enabled: !signedOut },
  });
  const hasValidSession =
    typeof me?.role === "string" && me.role.trim().length > 0;
  const role = hasValidSession ? (me.role as Role) : null;
  // A 401 just means "not signed in"; anything else is an outage worth surfacing.
  const meStatus = (error as { status?: number } | null)?.status;
  const isOutage = isError && meStatus !== 401;

  if (!hasValidSession) {
    return (
      <AccessPortal outage={isOutage} onRetry={() => void refetch()}>
        {signedOut && (
          <div
            role="status"
            className="mb-4 rounded-md border border-border bg-muted p-3 text-sm"
          >
            {revocationConfirmed
              ? "You are signed out."
              : "Signed out locally. Server sign-out could not be confirmed; the session may still be active."}
            {!revocationConfirmed && (
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                disabled={revoking}
                onClick={async () => {
                  setRevoking(true);
                  try {
                    await logout();
                    setRevocationConfirmed(true);
                  } catch {
                    /* Keep the unconfirmed state visible. */
                  } finally {
                    setRevoking(false);
                  }
                }}
              >
                Retry server sign-out
              </Button>
            )}
          </div>
        )}
        {!signedOut && isLoading ? <SessionSkeleton /> : <SignInPanel />}
      </AccessPortal>
    );
  }

  // The institutional data room is discoverable only to its intended role.
  // Other signed-in users should not be offered a cross-tenant product they
  // can never enter, even as a disabled tile.
  const visibleApps = APPS.filter(
    (app) => app.key !== "bank-data-room" || role === "bank_user",
  );

  // Signed in: float the tiles this account can open to the front.
  const tiles =
    role === null
      ? visibleApps
      : [...visibleApps].sort((a, b) => {
          const opens = (t: AppTile) =>
            t.allowedRoles === null || t.allowedRoles.includes(role) ? 0 : 1;
          return opens(a) - opens(b);
        });

  return (
    <div className="min-h-screen bg-[#f3f6f5]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Skip to content
      </a>
      <PortalHeader
        right={
          <span
            className="max-w-[55%] truncate rounded-md border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-900"
            data-testid="badge-session"
          >
            {me.fullName ?? me.email ?? roleLabel(me.role)} ·{" "}
            {roleLabel(me.role)}
          </span>
        }
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-7xl px-5 py-10 focus:outline-none sm:px-8 sm:py-14"
      >
        <section className="max-w-3xl">
          <p className="text-xs font-extrabold uppercase text-teal-700">
            Signed in as {roleLabel(me.role)}
          </p>
          <h1 className="landing-display mt-3 text-4xl font-bold text-slate-950 sm:text-5xl">
            Choose your workspace
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600 sm:text-lg">
            Your workspace is ready. These are the apps this account can open.
          </p>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_20rem]">
          {/* Sign-in first in DOM: on a phone it sits right under the hero,
              and the h2 "Sign in" precedes the tile h3s. */}
          <aside className="mx-auto w-full max-w-md space-y-5 lg:order-last lg:max-w-none">
            <SignedInPanel me={me} />
          </aside>

          <section
            aria-labelledby="workspaces-heading"
            className="lg:order-first"
          >
            <h2 id="workspaces-heading" className="sr-only">
              Workspaces
            </h2>
            <div className="grid gap-5 sm:grid-cols-2">
              {tiles.map((app) => (
                <AppCard
                  key={app.key}
                  app={app}
                  role={role}
                  isLoading={isLoading}
                  onRequestSignIn={focusEmailField}
                />
              ))}
            </div>
          </section>
        </div>

        <footer className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t pt-6 text-xs text-muted-foreground">
          <p>
            Valo — Lagos, Nigeria. The Penalty Calculator is free for everyone;
            the other workspaces need a sign-in.
          </p>
          <nav className="flex items-center gap-4" aria-label="Footer">
            <a
              href="/penalty-calculator/"
              className="font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              data-testid="link-footer-calculator"
            >
              Penalty calculator
            </a>
            <button
              type="button"
              onClick={focusSignOutButton}
              className="font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              data-testid="button-footer-switch-account"
            >
              Switch account
            </button>
          </nav>
        </footer>
      </main>
    </div>
  );
}
