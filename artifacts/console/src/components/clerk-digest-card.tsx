import {
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";

// The firm's weekly Clerk digest — read-only, spends no tokens. Fully
// self-gating: it renders only when the query succeeds. 404 means no digest
// has been generated yet (the sweep is opt-in), 400 means the viewer has no
// firm scope (operators) — in every non-success case the card simply isn't
// there, so it is safe to mount on any page.
export function ClerkWeeklyDigestCard() {
  // No retry: 404/400 are final answers, not transient failures.
  const digest = useGetClerkDigest({
    query: { queryKey: getGetClerkDigestQueryKey(), retry: false },
  });
  if (!digest.isSuccess) return null;
  return (
    <Card data-testid="clerk-digest">
      <CardHeader>
        <CardTitle className="text-base">{digest.data.headline}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {digest.data.bullets.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {digest.data.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Week of {formatDate(digest.data.weekStart)} ·{" "}
          {digest.data.source === "clerk"
            ? "Written by Clerk"
            : "Generated from your data"}
        </p>
      </CardContent>
    </Card>
  );
}
