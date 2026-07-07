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
import { useToast } from "@/hooks/use-toast";
import { Download, FileText } from "lucide-react";
import { formatNaira, formatDate } from "@/lib/format";

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
  const [period, setPeriod] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const { data, isLoading } = useListStatements();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const generate = useGenerateStatements();

  const handleGenerate = () => {
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
            <Download className="w-4 h-4 mr-2" /> Export all
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
              <Label htmlFor="period">Period (YYYY-MM)</Label>
              <Input
                id="period"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="2026-06"
                className="w-40"
                data-testid="input-period"
              />
            </div>
            <Button
              onClick={handleGenerate}
              disabled={generate.isPending}
              data-testid="button-generate"
            >
              Generate
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-72" />
      ) : statements.length === 0 ? (
        <p className="text-muted-foreground" data-testid="text-empty">
          No statements yet. Generate one for a closed period.
        </p>
      ) : (
        <div className="space-y-4">
          {statements.map((s) => (
            <Card key={s.id} data-testid={`card-statement-${s.id}`}>
              <CardContent className="pt-6">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <p className="font-semibold flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary" />
                      {s.firmName ?? "Firm"} · {s.period}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.tierKey.replace(/_/g, " ")} · generated{" "}
                      {formatDate(s.generatedAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportCsv([s], `${s.firmName ?? s.firmId}-${s.period}`)}
                    data-testid={`button-export-${s.id}`}
                  >
                    <Download className="w-4 h-4 mr-1" /> Export
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
                    <p className="font-medium">
                      {formatNaira(s.subscriptionAmount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Overage</p>
                    <p className="font-medium">{formatNaira(s.overageAmount)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Billing total</p>
                    <p className="font-medium">{formatNaira(s.billingAmount)}</p>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Revenue share ({pct(s.revenueSharePct)})
                  </span>
                  <span
                    className="text-lg font-bold text-primary"
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
