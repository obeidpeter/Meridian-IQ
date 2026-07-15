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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { FilePickerButton } from "@/components/file-picker-button";
import {
  Download,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { COLUMNS, parseCsv, mapGridRows, isExcel } from "./import-parse";

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
// container, so a legacy binary .xls surfaces the read-error toast. The pure
// grid-to-row mapping lives in ./import-parse (mapGridRows) so it can be tested.
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

  const [raw, setRaw] = useState("");
  const [fileRows, setFileRows] = useState<InvoiceImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceImportResult | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);

  const rows = useMemo(
    () => fileRows ?? parseCsv(raw),
    [fileRows, raw],
  );

  const onFile = async (file: File) => {
    setResult(null);
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

  const run = async (commit: boolean) => {
    if (!me?.clientPartyId || rows.length === 0) return;
    try {
      const res = await importMut.mutateAsync({
        data: { clientPartyId: me.clientPartyId, commit, rows },
      });
      setResult(res);
      if (commit) {
        // Not awaited: a background refetch rejection must not surface as a
        // false "import failed" error after the rows were already created.
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        toast({
          title: "Import complete",
          description: `${res.createdCount} invoice(s) created.`,
        });
      } else {
        toast({
          title: "Validation done",
          description: `${res.validCount} valid, ${res.invalidCount} with issues.`,
        });
      }
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : "Please check your file.",
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
          r.invoiceNumber || "",
          r.status,
          `"${r.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}"`,
        ].join(","),
      )
      .join("\n");
    download("import-results.csv", `${head}\n${body}`);
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
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <FilePickerButton
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              label="Upload Excel or CSV"
              onFile={onFile}
            />
            <Button
              variant="ghost"
              onClick={() => download("meridianiq-template.csv", TEMPLATE)}
            >
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> CSV template
            </Button>
            <Button variant="ghost" onClick={downloadExcelTemplate}>
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Excel template
            </Button>
          </div>
          <div>
            <Label htmlFor="import-rows" className="sr-only">
              Paste CSV rows
            </Label>
            <Textarea
              id="import-rows"
              className="min-h-[140px] font-mono"
              placeholder="…or paste CSV rows here (first line = column headers)"
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setFileRows(null);
                setFileName(null);
                setResult(null);
              }}
            />
          </div>
          {fileName && (
            <p className="text-sm text-muted-foreground">
              Loaded <span className="font-medium">{fileName}</span> — {rows.length} row(s).
            </p>
          )}
          {!fileName && rows.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {rows.length} row(s) ready.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => run(false)}
          disabled={rows.length === 0 || importMut.isPending}
        >
          Validate rows
        </Button>
        <Button
          onClick={onCommitClick}
          disabled={rows.length === 0 || importMut.isPending}
        >
          <FileSpreadsheet className="w-4 h-4 mr-2" aria-hidden="true" />
          {importMut.isPending ? "Working…" : "Import valid rows"}
        </Button>
      </div>

      <AlertDialog open={confirmCommit} onOpenChange={setConfirmCommit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Skip {knownInvalidCount} invalid row(s)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Only valid rows become invoices — the {knownInvalidCount} row(s)
              with issues are skipped and stay in your file. You can fix and
              re-import them later.
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
              {result.committed ? "Import results" : "Validation preview"}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={downloadResults}>
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Download
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>Total: {result.total}</span>
              <span className="text-emerald-700 dark:text-emerald-400">
                Valid: {result.validCount}
              </span>
              <span className="text-destructive">Invalid: {result.invalidCount}</span>
              {result.committed && <span>Created: {result.createdCount}</span>}
            </div>
            <div className="space-y-2">
              {result.rows.map((r) => (
                <div
                  key={r.rowNumber}
                  className="flex items-start gap-2 text-sm border rounded-md px-3 py-2"
                >
                  {r.status === "invalid" ? (
                    <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
                  )}
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
