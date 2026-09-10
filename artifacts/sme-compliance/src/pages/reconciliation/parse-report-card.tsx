import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RowStatusIcon } from "@/components/row-status-icon";
import { Sparkles } from "lucide-react";
import { formatNaira, formatDate, formatPct, humanize } from "@/lib/format";
import type { StatementImportResult } from "@workspace/api-client-react";

/**
 * Section 1's outcome card ("Parse report" / "Statement committed") — render
 * only. The import STATE stays in Reconciliation: the commit flow's held
 * proposedCsv/report coupling (see statementImportBody) is deliberate.
 */
export function ParseReportCard({
  report,
  reportSource,
}: {
  report: StatementImportResult;
  reportSource: "csv" | "pdf";
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {report.committed ? "Statement committed" : "Parse report"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reportSource === "pdf" && !report.committed && (
          <Alert data-testid="banner-scanned-preview">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Clerk read this scanned statement</AlertTitle>
            <AlertDescription>
              The rows below are what Clerk proposed from the PDF — and exactly
              what will be committed. Check the dates, amounts and directions
              against your statement; nothing is saved until you press “Commit
              statement”.
            </AlertDescription>
          </Alert>
        )}
        {/* role=status: the report lands asynchronously after "Check
            parsing" / "Commit statement", so announce the headline
            numbers instead of leaving screen readers to hunt. */}
        <div
          className="flex flex-wrap items-center gap-4 text-sm"
          role="status"
        >
          <span>
            Format:{" "}
            <span className="font-mono text-xs bg-muted rounded px-1.5 py-0.5">
              {report.formatKey || "unknown"}
            </span>
          </span>
          <span>Lines: {report.lineCount}</span>
          <span className="text-emerald-700 dark:text-emerald-400">
            Parsed: {report.parsedCount}
          </span>
          <span
            className={
              report.parseRate < 1
                ? "text-destructive"
                : "text-emerald-700 dark:text-emerald-400"
            }
          >
            Parse rate: {formatPct(report.parseRate, 0)}
          </span>
        </div>
        {!report.committed && (
          <p className="text-xs text-muted-foreground">
            Nothing has been saved yet — review the rows below, then press
            “Commit statement”. Invalid rows are skipped on commit.
          </p>
        )}
        <div className="space-y-2">
          {report.rows.map((r) => (
            <div
              key={r.lineNo}
              className={`flex items-start gap-2 text-sm border rounded-md px-3 py-2 ${
                r.parseStatus === "invalid"
                  ? "border-destructive/40 bg-destructive/5"
                  : ""
              }`}
            >
              <RowStatusIcon invalid={r.parseStatus === "invalid"} />
              <div className="min-w-0">
                <p className="font-medium">
                  Line {r.lineNo}
                  {r.parseStatus === "parsed" ? (
                    <span className="font-normal">
                      {" "}
                      · {formatDate(r.valueDate)} ·{" "}
                      {humanize(r.direction || "—")} {formatNaira(r.amount)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      (invalid)
                    </span>
                  )}
                </p>
                {r.narration && (
                  <p className="text-xs text-muted-foreground truncate">
                    {r.narration}
                  </p>
                )}
                {r.error && (
                  <p className="text-xs text-destructive mt-1">{r.error}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
