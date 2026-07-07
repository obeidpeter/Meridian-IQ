import { useGetUnearnedIncome } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNaira } from "@/lib/format";

export function UnearnedIncomePage() {
  const { data, isLoading, error } = useGetUnearnedIncome();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="text-destructive" data-testid="text-error">
        Unable to load unearned income.
      </p>
    );
  }

  const pct = (Number(data.revenueSharePct) * 100).toFixed(1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Unearned income & revenue share
        </h1>
        <p className="text-muted-foreground mt-1">
          Pipeline value not yet billed, at your current {pct}% revenue share.
          Reconciles to live billing to the naira.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="stat-implied-billing">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Implied monthly billing
            </p>
            <p className="text-2xl font-bold mt-1">
              {formatNaira(data.impliedMonthlyBilling)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {data.eligibleCount} eligible prospect
              {data.eligibleCount === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-monthly-share">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Monthly revenue share
            </p>
            <p className="text-2xl font-bold mt-1 text-primary">
              {formatNaira(data.impliedMonthlyRevenueShare)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">at {pct}%</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-annual-share">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Annualised revenue share
            </p>
            <p className="text-2xl font-bold mt-1">
              {formatNaira(data.impliedAnnualRevenueShare)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {data.tierKey.replace(/_/g, " ")} tier
            </p>
          </CardContent>
        </Card>
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
                      <td className="py-2.5 capitalize text-muted-foreground">
                        {p.stage.replace(/_/g, " ")}
                      </td>
                      <td className="py-2.5 text-right">
                        {p.estimatedMonthlyInvoices}
                      </td>
                      <td className="py-2.5 text-right">
                        {formatNaira(p.impliedMonthlyBilling)}
                      </td>
                      <td className="py-2.5 text-right font-medium">
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
