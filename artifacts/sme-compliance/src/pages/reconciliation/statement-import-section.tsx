import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FilePickerButton } from "@/components/file-picker-button";
import { Landmark, ScanSearch } from "lucide-react";
import { ParseReportCard } from "./parse-report-card";
import type { ReconciliationState } from "./use-reconciliation";

/**
 * Section 1 — the statement input card, the "Check parsing" / "Commit
 * statement" row and the parse report. Returns a fragment (no wrapper
 * element) so the three stay direct children of the page's space-y-6
 * container, exactly as before the split.
 */
export function StatementImportSection({
  csv,
  editCsv,
  filename,
  pdf,
  csvLines,
  onFile,
  run,
  importMut,
  report,
  reportSource,
}: Pick<
  ReconciliationState,
  | "csv"
  | "editCsv"
  | "filename"
  | "pdf"
  | "csvLines"
  | "onFile"
  | "run"
  | "importMut"
  | "report"
  | "reportSource"
>) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            1. Add a bank statement (CSV or scanned PDF)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <FilePickerButton
              accept=".csv,.pdf,text/csv,text/plain,application/pdf"
              label="Upload CSV or PDF"
              onFile={onFile}
            />
          </div>
          <div>
            <Label htmlFor="statement-csv" className="sr-only">
              Bank statement CSV
            </Label>
            <Textarea
              id="statement-csv"
              className="min-h-[140px] font-mono"
              placeholder="…or paste your bank statement CSV here (first line = column headers)"
              value={csv}
              onChange={(e) => editCsv(e.target.value)}
            />
          </div>
          {pdf && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-pdf-loaded"
            >
              Loaded <span className="font-medium">{pdf.name}</span> — a scanned
              statement. Clerk will read it into lines; run the parse check to
              see what it found before committing.
            </p>
          )}
          {!pdf && csvLines.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {filename ? (
                  <>
                    Loaded <span className="font-medium">{filename}</span>{" "}
                    —{" "}
                  </>
                ) : null}
                {csvLines.length} line(s) ready (including headers).
              </p>
              <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-x-auto">
                {csvLines.slice(0, 6).join("\n")}
                {csvLines.length > 6 ? "\n…" : ""}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => run(false)}
          disabled={(!pdf && !csv.trim()) || importMut.isPending}
        >
          <ScanSearch className="w-4 h-4 mr-2" aria-hidden="true" />
          {importMut.isPending
            ? pdf
              ? "Clerk is reading…"
              : "Working…"
            : "Check parsing"}
        </Button>
        {report && !report.committed && (
          <Button
            onClick={() => run(true)}
            disabled={(!pdf && !csv.trim()) || importMut.isPending}
          >
            <Landmark className="w-4 h-4 mr-2" aria-hidden="true" />
            {importMut.isPending ? "Working…" : "Commit statement"}
          </Button>
        )}
      </div>

      {report && (
        <ParseReportCard report={report} reportSource={reportSource} />
      )}
    </>
  );
}
