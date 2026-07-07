import { Link } from "wouter";
import { useGetPortfolio } from "@workspace/api-client-react";
import type { ClientRisk } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Users, FileWarning, Clock, ChevronRight } from "lucide-react";
import { formatNaira, formatDate } from "@/lib/format";

function riskBadge(risk: ClientRisk["penaltyRisk"]): string {
  switch (risk) {
    case "high":
      return "bg-red-100 text-red-800 border-red-200";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-200";
    default:
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: string;
  icon: typeof Users;
  tone?: "danger" | "warning";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon
            className={`w-8 h-8 ${
              tone === "danger"
                ? "text-red-500"
                : tone === "warning"
                  ? "text-amber-500"
                  : "text-primary"
            }`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function Portfolio() {
  const { data, isLoading, error } = useGetPortfolio();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="text-destructive" data-testid="text-error">
        Unable to load portfolio.
      </p>
    );
  }

  const clients = [...data.clients].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.penaltyRisk] - order[b.penaltyRisk];
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Client portfolio
        </h1>
        <p className="text-muted-foreground mt-1">
          Penalty risk across {data.clientCount} client
          {data.clientCount === 1 ? "" : "s"}. Click a client to reach any
          failing invoice.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Clients"
          value={String(data.clientCount)}
          icon={Users}
          testId="stat-clients"
        />
        <StatCard
          label="High-risk clients"
          value={String(data.highRiskCount)}
          icon={AlertTriangle}
          tone="danger"
          testId="stat-high-risk"
        />
        <StatCard
          label="Unsubmitted invoices"
          value={`${data.totalUnsubmittedCount} · ${formatNaira(data.totalUnsubmittedValue)}`}
          icon={FileWarning}
          tone="warning"
          testId="stat-unsubmitted"
        />
        <StatCard
          label="Overdue deadlines"
          value={String(data.totalOverdueCount)}
          icon={Clock}
          tone="danger"
          testId="stat-overdue"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Clients by penalty risk</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {clients.map((c) => (
              <Link
                key={c.clientPartyId}
                href={`/clients/${c.clientPartyId}`}
                data-testid={`row-client-${c.clientPartyId}`}
                className="flex items-center gap-4 py-3 hover:bg-muted/50 -mx-2 px-2 rounded-md transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.legalName}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.totalInvoices} invoices · {c.failedCount} failed ·{" "}
                    {c.pendingCount} pending
                    {c.nextDeadline
                      ? ` · next: ${c.nextDeadline.title} ${formatDate(c.nextDeadline.dueDate)}`
                      : ""}
                  </p>
                </div>
                {c.unsubmittedCount > 0 && (
                  <div className="hidden sm:block text-right">
                    <p className="text-sm font-medium">
                      {formatNaira(c.unsubmittedValue)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.unsubmittedCount} unsubmitted
                    </p>
                  </div>
                )}
                <span
                  className={`text-xs font-medium px-2.5 py-1 rounded-full border ${riskBadge(c.penaltyRisk)}`}
                  data-testid={`badge-risk-${c.clientPartyId}`}
                >
                  {c.penaltyRisk} risk
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
