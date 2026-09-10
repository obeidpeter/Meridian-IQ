import { Link } from "wouter";
import type { InvoiceImportResult } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Metric, MetricStrip } from "@workspace/web-ui";
import { pillClasses } from "@workspace/format";
import {
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  XCircle,
} from "lucide-react";
import { ROW_STATUS } from "./helpers";
import { StepMark } from "./step-mark";

/** Step 3 — the validation preview / import results: metrics and the row table. */
export function ImportResultsCard({
  result,
  onDownloadFailed,
  onDownloadResults,
}: {
  result: InvoiceImportResult;
  onDownloadFailed: () => void;
  onDownloadResults: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <StepMark n={3} done={result.committed} />
          {result.committed ? "Import results" : "Validation preview"}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {result.invalidCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDownloadFailed}
              data-testid="button-download-failed"
            >
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Download
              failed rows
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDownloadResults}>
            <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Download
            results
          </Button>
          {result.committed && result.createdCount > 0 && (
            <Button asChild size="sm" data-testid="button-view-invoices">
              <Link href="/invoices">View invoices</Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.committed && result.createdCount > 0 && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-drafts-note"
          >
            Imported invoices are saved as drafts — nothing has been sent to
            FIRS yet. Review and submit them for stamping from the Invoices
            page.
          </p>
        )}
        {/* The tiles show the numbers; the visually-hidden spans keep the
                  "Label: N" wording the journeys and screen readers read. */}
        <MetricStrip label="Import summary">
          <Metric
            label="Rows"
            value={
              <>
                <span aria-hidden="true">{result.total}</span>
                <span className="sr-only" data-testid="text-total-count">
                  Total: {result.total}
                </span>
              </>
            }
            detail="In this file"
            icon={<FileSpreadsheet className="size-4" aria-hidden="true" />}
          />
          <Metric
            label="Valid"
            value={
              <>
                <span aria-hidden="true">{result.validCount}</span>
                <span className="sr-only" data-testid="text-valid-count">
                  Valid: {result.validCount}
                </span>
              </>
            }
            detail={result.committed ? "Passed every check" : "Ready to import"}
            tone="positive"
            icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          />
          <Metric
            label="Invalid"
            value={
              <>
                <span aria-hidden="true">{result.invalidCount}</span>
                <span className="sr-only" data-testid="text-invalid-count">
                  Invalid: {result.invalidCount}
                </span>
              </>
            }
            detail={
              result.invalidCount > 0 ? "Fix and re-import" : "Nothing to fix"
            }
            tone={result.invalidCount > 0 ? "critical" : "default"}
            icon={<XCircle className="size-4" aria-hidden="true" />}
          />
          {result.committed && (
            <Metric
              label="Created"
              value={
                <>
                  <span aria-hidden="true">{result.createdCount}</span>
                  <span className="sr-only" data-testid="text-created-count">
                    Created: {result.createdCount}
                  </span>
                </>
              }
              detail="Saved as drafts"
              tone="info"
              icon={<ClipboardCheck className="size-4" aria-hidden="true" />}
            />
          )}
        </MetricStrip>
        <div className="overflow-x-auto rounded-[var(--mi-radius)] border border-border">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead className="bg-muted/50 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Row</th>
                <th className="px-3 py-2">Invoice number</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">What to fix</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.rows.map((r) => {
                const status = ROW_STATUS[r.status] ?? {
                  label: r.status,
                  tone: "slate" as const,
                };
                return (
                  <tr
                    key={r.rowNumber}
                    data-testid={`row-import-${r.rowNumber}`}
                  >
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {r.rowNumber}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {r.invoiceNumber || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={pillClasses(status.tone)}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.errors.length > 0 ? (
                        <ul className="space-y-0.5 text-xs text-destructive">
                          {r.errors.map((e, i) => (
                            <li key={i}>
                              <span className="font-semibold">{e.field}</span>:{" "}
                              {e.message}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
