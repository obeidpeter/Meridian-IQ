import { ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorStatus } from "@/lib/errors";

// Full navigation back to the origin landing page. The session cookie is
// origin-wide (Path=/), so signing in there re-authenticates every app.
export const PORTAL_URL = "/login";

function BrandSplash({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="text-2xl font-bold text-primary">MeridianIQ</span>
      {children}
    </div>
  );
}

/**
 * Gates the routed app behind the real first-party session.
 *  • loading    → centered brand + spinner
 *  • 401        → not signed in; full-navigate to the landing page
 *  • other error→ branded "Can't reach MeridianIQ" splash with Retry
 *  • wrong role → centered card explaining which account type is required
 *  • allowed    → render children
 */
export function RequireSession({
  allowedRoles,
  children,
}: {
  allowedRoles: string[];
  children: ReactNode;
}) {
  const { data: me, isLoading, isError, error, refetch } = useGetMe({
    query: { retry: false, queryKey: getGetMeQueryKey() },
  });

  if (isLoading) {
    return (
      <BrandSplash>
        <div role="status" className="flex flex-col items-center gap-2">
          <Spinner className="size-6 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading your workspace…</span>
        </div>
      </BrandSplash>
    );
  }

  if (isError && errorStatus(error) !== 401) {
    // A transient failure (network blip, 5xx) is not a missing session —
    // offer a retry instead of bouncing a signed-in user to the portal.
    return (
      <BrandSplash>
        <p className="text-sm text-muted-foreground max-w-sm">
          Can't reach MeridianIQ right now. Check your connection and try
          again.
        </p>
        <Button
          variant="outline"
          onClick={() => refetch()}
          data-testid="button-retry-session"
        >
          Retry
        </Button>
      </BrandSplash>
    );
  }

  if (isError || !me) {
    // Not signed in (or the session expired) — send them to the portal to
    // authenticate. A full navigation, not a wouter push.
    window.location.href = PORTAL_URL;
    return null;
  }

  if (!allowedRoles.includes(me.role)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-md w-full" data-testid="card-wrong-role">
          <CardContent className="pt-6 space-y-4">
            <div>
              <h1 className="text-xl font-bold">Wrong workspace</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Signed in as {me.role}. This workspace needs a{" "}
                {allowedRoles.join(" or ")} account.
              </p>
            </div>
            <Button
              onClick={() => {
                window.location.href = PORTAL_URL;
              }}
              data-testid="button-back-to-portal"
            >
              Back to the MeridianIQ portal
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
