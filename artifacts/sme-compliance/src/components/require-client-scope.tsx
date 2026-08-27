import type { ReactNode } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";

/**
 * Client-scope guard. Every client-scoped query in this app is keyed on
 * `me.clientPartyId`; a firm user browsing without a client scope would
 * otherwise see fabricated zeros. Render the explanation instead.
 * RequireSession has already resolved `me` before any page mounts.
 */
export function RequireClientScope({
  thing,
  children,
}: {
  /** What this page shows, e.g. "a compliance dashboard". */
  thing: string;
  children: ReactNode;
}) {
  const { data: me } = useGetMe();

  if (me && !me.clientPartyId) {
    // A firm principal's account never gains a client scope — point them at
    // the console, where their portfolio work lives, instead of telling them
    // to "sign in with a client account" they will never have.
    const isFirmUser = me.role === "firm_admin" || me.role === "firm_staff";
    return (
      <Card>
        <CardContent
          className="pt-6 text-sm text-muted-foreground space-y-3"
          data-testid="text-no-client-scope"
        >
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {isFirmUser ? (
                <>
                  Your firm account isn't pinned to a client business, so
                  there's no {thing} to show here. Open a client from the
                  Accountant Console to work on their behalf.
                </>
              ) : (
                <>
                  Your account isn't scoped to a client business, so there's
                  no {thing} to show here. Sign in with a client account.
                </>
              )}
            </span>
          </div>
          {isFirmUser && (
            <Button asChild variant="outline" size="sm">
              <a href="/console/" data-testid="link-open-console">
                Open the Accountant Console
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return <>{children}</>;
}
