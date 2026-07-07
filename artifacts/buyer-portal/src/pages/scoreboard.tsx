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
import { Download } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function toCsv(rows: ScoreboardRow[]): string {
  const header = [
    "Rank",
    "Supplier",
    "Compliance score",
    "Stamped rate",
    "Confirmed rate",
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
      r.complianceScore,
      r.stampedRate,
      r.confirmedRate,
      r.invoiceCount,
      r.confirmedCount,
      r.outstandingCount,
      r.queriedCount,
      r.vatAtRisk,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export function Scoreboard() {
  const { data, isLoading, error } = useGetBuyerScoreboard();

  const exportCsv = (rows: ScoreboardRow[]) => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "supplier-scoreboard.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    if (isFeatureDisabled(error)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Supplier scoreboard
          </h1>
          <FeatureUnavailable feature="The supplier scoreboard" />
        </div>
      );
    }
    return (
      <p className="text-destructive" data-testid="text-error">
        Unable to load the scoreboard.
      </p>
    );
  }

  const rows = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Supplier scoreboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Suppliers ranked by stamping and confirmation compliance.
          </p>
        </div>
        {rows.length > 0 && (
          <Button
            variant="outline"
            onClick={() => exportCsv(rows)}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-empty">
              No suppliers to rank yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="min-w-40">Compliance score</TableHead>
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
                      <TableCell className="font-medium text-muted-foreground">
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
                      <TableCell className="text-right">
                        {r.invoiceCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.outstandingCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.queriedCount}
                      </TableCell>
                      <TableCell className="text-right font-medium text-red-700">
                        {formatNaira(r.vatAtRisk)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
