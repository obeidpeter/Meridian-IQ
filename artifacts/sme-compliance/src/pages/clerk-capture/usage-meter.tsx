import { useGetClerkUsage } from "@workspace/api-client-react";
import { usagePct } from "@/lib/clerk";
import { ClerkUsageBreakdown } from "@/components/clerk-usage-breakdown";

// Small allowance meter for the page header. The endpoint 400s for
// principals without a firm allowance, and the meter is a nicety — any error
// (or a still-loading query) simply renders nothing. Below the bar, the
// per-purpose breakdown shows where this month's tokens actually went
// (nothing extra when there's been no spend).
export function UsageMeter() {
  const { data: usage, isError } = useGetClerkUsage();
  if (isError || !usage) return null;
  const pct = usagePct(usage.usedTokens, usage.budgetTokens);
  return (
    <div className="w-48" data-testid="meter-clerk-usage">
      <p className="text-xs text-muted-foreground text-right">
        Clerk allowance: {pct}% used this month
      </p>
      <div
        className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Clerk allowance used this month"
      >
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 90
              ? "bg-destructive"
              : pct >= 75
                ? "bg-amber-500"
                : "bg-primary"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {usage.paceBand === "critical" ? (
        <p
          className="mt-1 text-xs text-right text-destructive"
          data-testid="text-usage-warning"
        >
          Allowance used up — Clerk submissions will be declined until next
          month.
        </p>
      ) : !usage.paceBand && pct >= 90 ? (
        // Version skew (new bundle, pre-0.22.0 server): paceBand is absent, so
        // keep the old client-side threshold rather than losing the warning.
        <p
          className="mt-1 text-xs text-right text-destructive"
          data-testid="text-usage-warning"
        >
          Nearly used up — submissions may be declined until next month.
        </p>
      ) : usage.paceBand === "warning" ? (
        // Budget pace (idea #7): the server projects month-end spend at the
        // current burn rate, so the heads-up can fire well before the cliff.
        <p
          className="mt-1 text-xs text-right text-amber-700 dark:text-amber-400"
          data-testid="text-usage-warning"
        >
          {pct >= 80
            ? "Nearly used up — submissions may be declined before month end."
            : "On pace to run out before month end at the current rate."}
        </p>
      ) : null}
      <ClerkUsageBreakdown byPurpose={usage.byPurpose} />
    </div>
  );
}
