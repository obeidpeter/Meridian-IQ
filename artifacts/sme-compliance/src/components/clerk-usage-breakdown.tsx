import { humanize } from "@/lib/format";
import {
  formatTokens,
  usageBreakdown,
  type UsagePurposeRow,
} from "@/lib/clerk";

/**
 * Compact per-purpose spend list under the capture page's allowance meter:
 * where this month's tokens actually went. Purposes are internal identifiers
 * ("extract_invoice"), humanized for display; zero rows hide, the biggest
 * spenders come first, and anything past the cap folds into a "+N more" line
 * (the dashboard's overflow idiom). No spend — or a pre-0.35.0 server that
 * doesn't send the array — renders nothing, leaving the meter as it was.
 */
export function ClerkUsageBreakdown({
  byPurpose,
}: {
  byPurpose?: UsagePurposeRow[];
}) {
  const { rows, overflow } = usageBreakdown(byPurpose);
  if (rows.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-0.5" data-testid="breakdown-clerk-usage">
      {rows.map((r) => (
        <div
          key={r.purpose}
          className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
          data-testid={`row-usage-purpose-${r.purpose}`}
        >
          <span className="truncate">{humanize(r.purpose)}</span>
          <span
            className="shrink-0 tabular-nums"
            title={`${r.tokens.toLocaleString("en-NG")} tokens`}
          >
            {formatTokens(r.tokens)}
          </span>
        </div>
      ))}
      {overflow > 0 && (
        <p
          className="text-xs text-muted-foreground text-right"
          data-testid="text-usage-purpose-more"
        >
          +{overflow} more
        </p>
      )}
    </div>
  );
}
