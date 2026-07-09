import type { ReactNode } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
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
    return (
      <Card>
        <CardContent
          className="pt-6 text-sm text-muted-foreground flex items-start gap-2"
          data-testid="text-no-client-scope"
        >
          <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Your account isn't scoped to a client business, so there's no{" "}
            {thing} to show here. Sign in with a client account.
          </span>
        </CardContent>
      </Card>
    );
  }

  return <>{children}</>;
}
