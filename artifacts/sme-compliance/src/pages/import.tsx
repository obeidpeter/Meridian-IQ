import { useMemo, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import writeXlsxFile from "write-excel-file/browser";
import {
  useGetMe,
  useImportInvoices,
  getListInvoicesQueryKey,
  type InvoiceImportRow,
  type InvoiceImportResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/page-header";
import { RequireClientScope } from "@/components/require-client-scope";
import {
  beginOperation,
  updateOperation,
  useFilePicker,
} from "@workspace/web-ui";
import { RowStatusIcon } from "@/components/row-status-icon";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { csvCell } from "@workspace/web-ui/csv";
import {
  COLUMNS,
  parseCsv,
  mapGridRows,
  isExcel,
  isLegacyExcel,
} from "./import-parse";

// Mirrors MAX_IMPORT_ROWS in the server route (routes/sme/import.ts): the
// server answers 413 above this, so surface the ceiling before anything is
// sent instead of after the upload fails.
const MAX_IMPORT_ROWS = 5000;

const TEMPLATE =
  COLUMNS.join(",") +
  "\n" +
  "INV-2001,Lagos Retail Ltd,12345678-0001,2026-07-01,2026-07-31,Consulting services,1,150000,0.075,NGN";

function download(filename: string, text: string, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadExcelTemplate() {
  const header = COLUMNS.map((value) => ({
    value,
    type: String,
    fontWeight: "bold" as const,
  }));
  const example = [
    "INV-2001",
    "Lagos Retail Ltd",
    "12345678-0001",
    "2026-07-01",
    "2026-07-31",
    "Consulting services",
    "1",
    "150000",
    "0.075",
    "NGN",
  ].map((value) => ({ value, type: String }));
  await writeXlsxFile([header, example], { sheet: "Invoices" }).toFile(
    "meridianiq-template.xlsx",
  );
}

// Parse the first sheet of an uploaded .xlsx workbook. The header row must use
// the same canonical column names as the CSV template so both formats map to the
// identical import-row model and run through the same server-side validator.
// read-excel-file replaces the unmaintained SheetJS build (prototype-pollution
// / ReDoS advisories) — it parses only the modern .xlsx (Office Open XML)
// container; legacy binary .xls is refused by name in onFile with guidance to
// re-save, because file.text() would "succeed" on it and produce garbage rows.
// The pure grid-to-row mapping lives in ./import-parse (mapGridRows) so it can
// be tested.
async function parseWorkbook(file: Blob): Promise<InvoiceImportRow[]> {
  const grid = await readSheet(file);
  return mapGridRows(grid);
}

export function Import() {
  usePageTitle("Bulk import");
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importMut = useImportInvoices();
  const operationKey = me ? `meridianiq:operations:${me.userId}` : null;

  const [raw, setRaw] = useState("");
  const [fileRows, setFileRows] = useState<InvoiceImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceImportResult | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const [commitInterrupted, setCommitInterrupted] = useState(false);

  const rows = useMemo(() => fileRows ?? parseCsv(raw), [fileRows, raw]);

  // Intra-file duplicate invoice numbers. The server never rejects a repeated
  // number — each repeat quietly becomes another draft with the same number —
  // so warning before anything is sent is the only guard.
  const duplicateNumbers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const n = (r.invoiceNumber ?? "").trim();
      if (!n) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 1);
  }, [rows]);

  const overCap = rows.length > MAX_IMPORT_ROWS;

  const onFile = async (file: File) => {
    if (importMut.isPending) return;
    setResult(null);
    setCommitInterrupted(false);
    if (isLegacyExcel(file.name)) {
      toast({
        title: "Legacy .xls isn't supported",
        description: "Save the sheet as .xlsx or CSV and upload it again.",
        variant: "destructive",
      });
      return;
    }
    try {
      if (isExcel(file.name)) {
        const parsed = await parseWorkbook(file);
        setFileRows(parsed);
        setFileName(file.name);
        setRaw("");
      } else {
        const text = await file.text();
        setRaw(text);
        setFileRows(null);
        setFileName(null);
      }
    } catch {
      toast({
        title: "Could not read file",
        description: "Use the template's columns in the first sheet.",
        variant: "destructive",
      });
    }
  };

  const filePicker = useFilePicker(onFile);

  const run = async (commit: boolean) => {
    if (!me?.clientPartyId || rows.length === 0) return;
    setCommitInterrupted(false);
    const operation = beginOperation(operationKey, {
      title: commit ? "Import invoices" : "Validate invoice import",
      kind: "import",
      route: "/import",
      detail: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
    });
    try {
      const res = await importMut.mutateAsync({
        data: { clientPartyId: me.clientPartyId, commit, rows },
      });
      setResult(res);
      updateOperation(operationKey, operation?.id, {
        status: commit && res.invalidCount > 0 ? "partial" : "succeeded",
        detail: commit
          ? `${res.createdCount} created, ${res.invalidCount} skipped.`
          : `${res.validCount} valid, ${res.invalidCount} with issues.`,
        savedSummary: commit
          ? `${res.createdCount} invoice draft(s) were created.`
          : "Validation only; no invoices were created.",
      });
      if (commit) {
        // Not awaited: a background refetch rejection must not surface as a
        // false "import failed" error after the rows were already created.
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        toast({
          title: "Import complete",
          description:
            res.invalidCount > 0
              ? `${res.createdCount} draft invoice(s) created, ${res.invalidCount} row(s) skipped — see the results below.`
              : `${res.createdCount} draft invoice(s) created — review and submit them from Invoices.`,
        });
      } else {
        toast({
          title: "Validation done",
          description: `${res.validCount} valid, ${res.invalidCount} with issues.`,
        });
      }
    } catch (e) {
      // No HTTP status means the request itself died (connection drop,
      // timeout): on a commit the server may still have created the invoices,
      // so never blame the file and never invite a blind retry.
      if (errorStatus(e) === undefined) {
        if (commit) {
          setCommitInterrupted(true);
          updateOperation(operationKey, operation?.id, {
            status: "partial",
            detail:
              "The connection ended before the server confirmed the import.",
            savedSummary:
              "Outcome unconfirmed. Check the invoice vault before importing again.",
          });
        } else {
          updateOperation(operationKey, operation?.id, {
            status: "failed",
            detail: "The server could not be reached for validation.",
            savedSummary: "Nothing was sent or created.",
          });
          toast({
            title: "Could not validate",
            description:
              "We couldn't reach the server. Check your connection and try again — nothing was sent.",
            variant: "destructive",
          });
        }
        return;
      }
      // An HTTP error means the request's transaction rolled back — nothing
      // was created.
      updateOperation(operationKey, operation?.id, {
        status: "failed",
        detail: commit
          ? "The server rejected the import."
          : "Validation failed.",
        savedSummary: "No invoices were created.",
      });
      toast({
        title: commit ? "Import failed" : "Validation failed",
        description: commit
          ? `${serverErrorMessage(e)} Nothing was created.`
          : serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  // Committing while the last validation still shows invalid rows silently
  // skips them — make that explicit before anything is created.
  const knownInvalidCount =
    result && !result.committed ? result.invalidCount : 0;

  const onCommitClick = () => {
    if (knownInvalidCount > 0) {
      setConfirmCommit(true);
    } else {
      run(true);
    }
  };

  const downloadResults = () => {
    if (!result) return;
    const head = "rowNumber,invoiceNumber,status,errors";
    const body = result.rows
      .map((r) =>
        [
          r.rowNumber,
          csvCell(r.invoiceNumber || ""),
          r.status,
          csvCell(r.errors.map((e) => `${e.field}: ${e.message}`).join("; ")),
        ].join(","),
      )
      .join("\n");
    download("import-results.csv", `${head}\n${body}`);
  };

  // The fix-and-retry loop the skip dialog promises: failed rows re-exported
  // in TEMPLATE format (the original cell values, not the error report) so
  // the user fixes just those rows and re-imports them without duplicating
  // the rows that were already created. rows[r.rowNumber - 1] is safe: both
  // parsers assign rowNumber = index + 1 and any row edit clears `result`.
  const downloadFailedRows = () => {
    if (!result) return;
    const body = result.rows
      .filter((r) => r.status === "invalid")
      .map((r) => rows[r.rowNumber - 1])
      .filter((row): row is InvoiceImportRow => Boolean(row))
      .map((row) => COLUMNS.map((c) => csvCell(String(row[c] ?? ""))).join(","))
      .join("\n");
    download("import-failed-rows.csv", `${COLUMNS.join(",")}\n${body}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk import"
        description="Upload a spreadsheet of invoices — we validate every row before creating anything."
      />

      <RequireClientScope thing="bulk import">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Add your rows</CardTitle>
          </CardHeader>
          <CardContent
            {...filePicker.dropProps}
            className={
              "space-y-4 rounded-md " +
              (filePicker.dragActive
                ? "outline-dashed outline-2 outline-primary/70 bg-primary/5"
                : "")
            }
          >
            <div className="flex flex-wrap gap-2">
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                {...filePicker.inputProps}
              />
              <Button
                variant="outline"
                onClick={filePicker.openPicker}
                disabled={importMut.isPending}
                data-testid="button-upload"
              >
                <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> Upload
                Excel or CSV
              </Button>
              <Button
                variant="ghost"
                onClick={() => download("meridianiq-template.csv", TEMPLATE)}
              >
                <Download className="w-4 h-4 mr-2" aria-hidden="true" /> CSV
                template
              </Button>
              <Button variant="ghost" onClick={downloadExcelTemplate}>
                <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Excel
                template
              </Button>
            </div>
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-import-hint"
            >
              CSV or Excel (.xlsx, first sheet) with the template’s columns — up
              to 5,000 rows per import. You can also drag and drop your file
              anywhere on this card.
            </p>
            <div>
              <Label htmlFor="import-rows" className="sr-only">
                Paste CSV rows
              </Label>
              <Textarea
                id="import-rows"
                data-testid="input-csv"
                className="min-h-[140px] font-mono"
                placeholder="…or paste CSV rows here (first line = column headers)"
                value={raw}
                disabled={importMut.isPending}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setFileRows(null);
                  setFileName(null);
                  setResult(null);
                  setCommitInterrupted(false);
                }}
              />
            </div>
            {fileName && (
              <p className="text-sm text-muted-foreground">
                Loaded <span className="font-medium">{fileName}</span> —{" "}
                {rows.length} row(s).
              </p>
            )}
            {!fileName && rows.length > 0 && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-rows-ready"
              >
                {rows.length} row(s) ready.
              </p>
            )}
            {overCap && (
              <p
                className="text-sm text-destructive"
                data-testid="text-over-cap"
              >
                {rows.length.toLocaleString()} rows is over the 5,000-row limit
                — split the file and import it in batches.
              </p>
            )}
            {duplicateNumbers.length > 0 && (
              <p
                className="text-sm text-amber-700 dark:text-amber-400"
                data-testid="text-duplicate-warning"
              >
                Duplicate invoice numbers in these rows:{" "}
                {duplicateNumbers
                  .slice(0, 3)
                  .map(([n, count]) => `${n} (×${count})`)
                  .join(", ")}
                {duplicateNumbers.length > 3
                  ? ` and ${duplicateNumbers.length - 3} more`
                  : ""}
                . Each repeat is imported as a separate draft with the same
                number — renumber or remove the repeats before importing.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h2 className="text-base font-semibold leading-snug">
            2. Validate and import
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => run(false)}
              disabled={rows.length === 0 || overCap || importMut.isPending}
              data-testid="button-validate"
            >
              Validate rows
            </Button>
            <Button
              onClick={onCommitClick}
              disabled={
                rows.length === 0 ||
                overCap ||
                importMut.isPending ||
                !result ||
                result.committed
              }
              data-testid="button-commit"
            >
              <FileSpreadsheet className="w-4 h-4 mr-2" aria-hidden="true" />
              {importMut.isPending ? "Working…" : "Import valid rows"}
            </Button>
            {!result && rows.length > 0 && !overCap && (
              <p className="text-sm text-muted-foreground">
                Validate first — commit unlocks after a validation pass.
              </p>
            )}
          </div>
        </div>

        {commitInterrupted && (
          <Alert variant="destructive" data-testid="alert-commit-interrupted">
            <AlertTitle>We couldn't confirm the import</AlertTitle>
            <AlertDescription>
              Your connection dropped before the server answered, so the
              invoices may or may not have been created.{" "}
              <Link href="/invoices" className="font-medium underline">
                Check your Invoices list
              </Link>{" "}
              before importing again to avoid duplicates.
            </AlertDescription>
          </Alert>
        )}

        {importMut.isPending && !result && <Skeleton className="h-40" />}

        <AlertDialog open={confirmCommit} onOpenChange={setConfirmCommit}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Skip {knownInvalidCount} invalid row(s)?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Only valid rows become invoices — the {knownInvalidCount} row(s)
                with issues are skipped. Afterwards, use “Download failed rows”
                in the results to fix and re-import just those rows.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Go back and fix</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmCommit(false);
                  run(true);
                }}
                data-testid="button-confirm-import"
              >
                Import valid rows
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {result && (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                3. {result.committed ? "Import results" : "Validation preview"}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                {result.invalidCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={downloadFailedRows}
                    data-testid="button-download-failed"
                  >
                    <Download className="w-4 h-4 mr-2" aria-hidden="true" />{" "}
                    Download failed rows
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={downloadResults}>
                  <Download className="w-4 h-4 mr-2" aria-hidden="true" />{" "}
                  Download results
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
                  Imported invoices are saved as drafts — nothing has been sent
                  to FIRS yet. Review and submit them for stamping from the
                  Invoices page.
                </p>
              )}
              <div className="flex flex-wrap gap-4 text-sm">
                <span data-testid="text-total-count">
                  Total: {result.total}
                </span>
                <span
                  className="text-emerald-700 dark:text-emerald-400"
                  data-testid="text-valid-count"
                >
                  Valid: {result.validCount}
                </span>
                <span
                  className="text-destructive"
                  data-testid="text-invalid-count"
                >
                  Invalid: {result.invalidCount}
                </span>
                {result.committed && (
                  <span data-testid="text-created-count">
                    Created: {result.createdCount}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {result.rows.map((r) => (
                  <div
                    key={r.rowNumber}
                    className="flex items-start gap-2 text-sm border rounded-md px-3 py-2"
                  >
                    <RowStatusIcon invalid={r.status === "invalid"} />
                    <div className="min-w-0">
                      <p className="font-medium">
                        Row {r.rowNumber}
                        {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}{" "}
                        <span className="text-muted-foreground font-normal">
                          (
                          {r.status === "invalid"
                            ? "Invalid"
                            : r.status === "created"
                              ? "Created"
                              : "Valid"}
                          )
                        </span>
                      </p>
                      {r.errors.length > 0 && (
                        <ul className="text-xs text-destructive mt-1 space-y-0.5">
                          {r.errors.map((e, i) => (
                            <li key={i}>
                              {e.field}: {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </RequireClientScope>
    </div>
  );
}
