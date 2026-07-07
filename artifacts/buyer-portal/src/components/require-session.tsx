import { ReactNode, useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

function goToPortal() {
  // Full navigation back to the origin's landing page (not a wouter route) —
  // sign-in and role selection live at "/", outside this app's basename.
  window.location.href = "/";
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
  const { data: me, isLoading, error } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  // No session (or it expired) — GET /api/me answered 401. Leave the app.
  useEffect(() => {
    if (error) goToPortal();
  }, [error]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
        <h1 className="text-2xl font-bold text-primary">MeridianIQ</h1>
        <Spinner className="size-6 text-muted-foreground" />
      </div>
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
