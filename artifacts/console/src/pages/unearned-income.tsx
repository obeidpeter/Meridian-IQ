import { useGetUnearnedIncome } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatNaira, formatPct, humanize } from "@/lib/format";

export function UnearnedIncomePage() {
  usePageTitle("Unearned income");
  const { data, isLoading, error, refetch } = useGetUnearnedIncome();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96 max-w-full mt-2" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Unearned income & revenue share
          </h1>
          <p className="text-muted-foreground mt-1">
            Pipeline value not yet billed, at your current revenue share.
          </p>
        </div>
        <QueryError thing="unearned income" onRetry={() => refetch()} />
      </div>
    );
  }

  const pct = formatPct(data.revenueSharePct);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Unearned income & revenue share
        </h1>
        <p className="text-muted-foreground mt-1">
          Pipeline value not yet billed, at your current {pct} revenue share.
          Reconciles to live billing to the naira.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Implied monthly billing"
          value={formatNaira(data.impliedMonthlyBilling)}
          detail={`${data.eligibleCount} eligible prospect${data.eligibleCount === 1 ? "" : "s"}`}
          testId="stat-implied-billing"
        />
        {/* text-primary on the value isn't in the shared tone map — this
            emphasised tile stays inline. */}
        <Card data-testid="stat-monthly-share">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Monthly revenue share
            </p>
            <p className="text-2xl font-bold mt-1 text-primary tabular-nums">
              {formatNaira(data.impliedMonthlyRevenueShare)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">at {pct}</p>
          </CardContent>
        </Card>
        <StatTile
          label="Annualised revenue share"
          value={formatNaira(data.impliedAnnualRevenueShare)}
          detail={`${humanize(data.tierKey)} tier`}
          testId="stat-annual-share"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Eligible prospects</CardTitle>
        </CardHeader>
        <CardContent>
          {data.prospects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No prospects in the pipeline yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">Prospect</th>
                    <th className="py-2 font-medium">Stage</th>
                    <th className="py-2 font-medium text-right">Est. inv/mo</th>
                    <th className="py-2 font-medium text-right">
                      Implied billing
                    </th>
                    <th className="py-2 font-medium text-right">
                      Revenue share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.prospects.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b last:border-0"
                      data-testid={`row-prospect-${p.id}`}
                    >
                      <td className="py-2.5 font-medium">{p.name}</td>
                      <td className="py-2.5 text-muted-foreground">
                        {humanize(p.stage)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {p.estimatedMonthlyInvoices}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatNaira(p.impliedMonthlyBilling)}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums">
                        {formatNaira(p.impliedMonthlyRevenueShare)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
