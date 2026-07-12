import { ReactNode, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorStatus } from "@/lib/errors";

function goToPortal() {
  // Full navigation back to the origin's login portal (not a wouter route) —
  // sign-in and role selection live at "/login", outside this app's basename.
  window.location.href = "/login";
}

function BrandSplash({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="text-2xl font-bold text-primary">MeridianIQ</span>
      {children}
    </div>
  );
}

/**
 * Gates the buyer portal behind the origin-wide session cookie. The principal
 * is resolved once here via useGetMe; every page then reads the buyer party
 * from the same session (server-side buyer scoping), so no page passes it in.
 */
export function RequireSession({
  allow,
  children,
}: {
  allow: string[];
  children: ReactNode;
}) {
  const { data: me, isLoading, error, refetch } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  // No session (or it expired) — GET /api/me answered 401. Leave the app.
  const unauthenticated = errorStatus(error) === 401;
  useEffect(() => {
    if (unauthenticated) goToPortal();
  }, [unauthenticated]);

  if (isLoading) {
    return (
      <BrandSplash>
        <Spinner className="size-6 text-muted-foreground" />
        <span className="sr-only" role="status">
          Loading your session
        </span>
      </BrandSplash>
    );
  }

  if (error && !unauthenticated) {
    // A transient failure (network blip, 5xx) is not a missing session —
    // offer a retry instead of ejecting the user mid-confirmation.
    return (
      <BrandSplash>
        <p className="text-sm text-muted-foreground max-w-sm">
          Couldn't reach MeridianIQ right now. Check your connection and try
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

  if (error || !me) {
    // Redirecting via the effect above; render nothing in the meantime.
    return null;
  }

  if (!allow.includes(me.role)) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md" data-testid="card-wrong-workspace">
          <CardContent className="pt-6 space-y-4">
            <div>
              <h1 className="text-xl font-bold">Wrong workspace</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Signed in as {me.role}. This workspace needs a{" "}
                {allow.join(" or ")} account.
              </p>
            </div>
            <Button onClick={goToPortal} data-testid="button-back-to-portal">
              Back to the MeridianIQ portal
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
