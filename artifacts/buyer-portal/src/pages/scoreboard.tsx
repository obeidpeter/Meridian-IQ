import type { ReactNode } from "react";
import { useGetBuyerScoreboard } from "@workspace/api-client-react";
import type { ScoreboardRow } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, Trophy } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Spreadsheet-safe cell: quote-escape, and neutralize formula injection by
 * prefixing cells that start with =, +, - or @ with a single quote.
 */
function csvCell(v: unknown): string {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows: ScoreboardRow[]): string {
  const header = [
    "Rank",
    "Supplier",
    "Compliance score %",
    "Stamped rate %",
    "Confirmed rate %",
    "Invoices",
    "Confirmed",
    "Outstanding",
    "Queried",
    "VAT at risk (NGN)",
  ];
  const lines = rows.map((r) =>
    [
      r.rank,
      r.supplierName,
      Math.round(r.complianceScore * 100),
      Math.round(r.stampedRate * 100),
      Math.round(r.confirmedRate * 100),
      r.invoiceCount,
      r.confirmedCount,
      r.outstandingCount,
      r.queriedCount,
      r.vatAtRisk,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...lines].join("\n");
}

function PageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Supplier scoreboard
        </h1>
        <p className="text-muted-foreground mt-1">
          Suppliers ranked by stamping and confirmation compliance.
        </p>
      </div>
      {actions}
    </div>
  );
}

export function Scoreboard() {
  usePageTitle("Supplier scoreboard");
  const { data, isLoading, error, refetch } = useGetBuyerScoreboard();

  const exportCsv = (rows: ScoreboardRow[]) => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `supplier-scoreboard-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-4 w-96 max-w-full mt-2" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-24" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="The supplier scoreboard" />
        ) : (
          <QueryError thing="the scoreboard" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const rows = data;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          rows.length > 0 ? (
            <Button
              variant="outline"
              onClick={() => exportCsv(rows)}
              data-testid="button-export-csv"
            >
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Export
              CSV
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-2">
              <Trophy
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-empty">
                No suppliers to rank yet
              </p>
              <p className="text-sm text-muted-foreground">
                Rankings build up as your suppliers stamp invoices and respond
                to confirmations on MeridianIQ.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="min-w-40">
                        Compliance score
                      </TableHead>
                      <TableHead className="text-right">Stamped</TableHead>
                      <TableHead className="text-right">Confirmed</TableHead>
                      <TableHead className="text-right">Invoices</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Queried</TableHead>
                      <TableHead className="text-right">VAT at risk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow
                        key={r.supplierPartyId}
                        data-testid={`row-scoreboard-${r.supplierPartyId}`}
                      >
                        <TableCell className="font-medium text-muted-foreground tabular-nums">
                          {r.rank}
                        </TableCell>
                        <TableCell className="font-medium">
                          {r.supplierName}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Progress
                              value={Math.round(r.complianceScore * 100)}
                              className="h-2 w-24"
                              aria-label={`Compliance score for ${r.supplierName}: ${pct(r.complianceScore)}`}
                            />
                            <span
                              className="text-sm font-medium tabular-nums"
                              data-testid={`text-score-${r.supplierPartyId}`}
                            >
                              {pct(r.complianceScore)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pct(r.stampedRate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pct(r.confirmedRate)}
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            ({r.confirmedCount})
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.invoiceCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.outstandingCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.queriedCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium text-red-700 dark:text-red-400">
                          {formatNaira(r.vatAtRisk)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Compliance score blends each supplier's stamped rate and
                confirmed rate — 100% means every invoice is stamped and
                confirmed.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
