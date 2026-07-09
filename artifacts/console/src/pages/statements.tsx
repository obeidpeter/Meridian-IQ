import { useState } from "react";
import {
  useListStatements,
  useGenerateStatements,
  getListStatementsQueryKey,
} from "@workspace/api-client-react";
import type { RevenueShareStatement } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { Download, FileText } from "lucide-react";
import { formatNaira, formatDate, humanize } from "@/lib/format";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Statements cover closed periods — default to the previous month.
function previousMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function pct(v: string) {
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function toCsv(rows: RevenueShareStatement[]): string {
  const header = [
    "Firm",
    "Period",
    "Tier",
    "Billed invoices",
    "Included",
    "Overage invoices",
    "Subscription (NGN)",
    "Overage (NGN)",
    "Billing total (NGN)",
    "Revenue share %",
    "Revenue share (NGN)",
    "Generated",
  ];
  const lines = rows.map((r) =>
    [
      r.firmName ?? r.firmId,
      r.period,
      r.tierKey,
      r.billedInvoices,
      r.includedInvoices,
      r.overageInvoices,
      r.subscriptionAmount,
      r.overageAmount,
      r.billingAmount,
      r.revenueSharePct,
      r.revenueShareAmount,
      r.generatedAt,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export function Statements() {
  usePageTitle("Statements");
  const [period, setPeriod] = useState(previousMonth);
  const { data, isLoading, error, refetch } = useListStatements();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const generate = useGenerateStatements();

  const periodValid = PERIOD_PATTERN.test(period);

  const handleGenerate = () => {
    if (!periodValid) return;
    generate.mutate(
      { data: { period } },
      {
        onSuccess: () => {
          toast({ title: `Statement generated for ${period}` });
          queryClient.invalidateQueries({
            queryKey: getListStatementsQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Could not generate statement", variant: "destructive" }),
      },
    );
  };

  const exportCsv = (rows: RevenueShareStatement[], label: string) => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `revenue-share-${label}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statements = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Revenue-share statements
          </h1>
          <p className="text-muted-foreground mt-1">
            Monthly per-firm statements reconciled to billing.
          </p>
        </div>
        {statements.length > 0 && (
          <Button
            variant="outline"
            onClick={() => exportCsv(statements, "all")}
            data-testid="button-export-all"
          >
            <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Export all
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate a statement</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="period">Period</Label>
              <Input
                id="period"
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="2026-06"
                className={`w-44 ${periodValid ? "" : "border-destructive"}`}
                aria-invalid={!periodValid}
                aria-describedby={periodValid ? undefined : "period-error"}
                data-testid="input-period"
              />
            </div>
            <Button
              onClick={handleGenerate}
              disabled={generate.isPending || !periodValid}
              data-testid="button-generate"
            >
              {generate.isPending ? "Generating…" : "Generate"}
            </Button>
          </div>
          {!periodValid && (
            <p
              id="period-error"
              role="alert"
              className="text-sm text-destructive mt-2"
              data-testid="text-period-error"
            >
              Pick a month in YYYY-MM format, e.g. 2026-06.
            </p>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6 space-y-4">
                <Skeleton className="h-5 w-64" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <Skeleton key={j} className="h-10" />
                  ))}
                </div>
                <Skeleton className="h-8" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <QueryError thing="statements" onRetry={() => refetch()} />
      ) : statements.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <FileText
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-empty">
              No statements generated yet
            </p>
            <p className="text-sm text-muted-foreground">
              Pick a closed month above and generate the first revenue-share
              statement — each firm's share is reconciled to billing.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {statements.map((s) => (
            <Card key={s.id} data-testid={`card-statement-${s.id}`}>
              <CardContent className="pt-6">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <p className="font-semibold flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary" aria-hidden="true" />
                      {s.firmName ?? "Firm"} · {s.period}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {humanize(s.tierKey)} · generated{" "}
                      {formatDate(s.generatedAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportCsv([s], `${s.firmName ?? s.firmId}-${s.period}`)}
                    data-testid={`button-export-${s.id}`}
                  >
                    <Download className="w-4 h-4 mr-1" aria-hidden="true" /> Export
                  </Button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Billed invoices</p>
                    <p className="font-medium">
                      {s.billedInvoices}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({s.includedInvoices} incl · {s.overageInvoices} over)
                      </span>
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Subscription</p>
                    <p className="font-medium tabular-nums">
                      {formatNaira(s.subscriptionAmount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Overage</p>
                    <p className="font-medium tabular-nums">{formatNaira(s.overageAmount)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Billing total</p>
                    <p className="font-medium tabular-nums">{formatNaira(s.billingAmount)}</p>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Revenue share ({pct(s.revenueSharePct)})
                  </span>
                  <span
                    className="text-lg font-bold text-primary tabular-nums"
                    data-testid={`text-share-${s.id}`}
                  >
                    {formatNaira(s.revenueShareAmount)}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
