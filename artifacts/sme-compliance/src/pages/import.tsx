import { useEffect, useMemo, useRef, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import writeXlsxFile from "write-excel-file/browser";
import {
  useGetMe,
  getImportInvoicesMutationOptions,
  importInvoices,
  getListInvoicesQueryKey,
  type InvoiceImportRow,
  type InvoiceImportResult,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  operationSessionKey,
  Metric,
  MetricStrip,
  updateOperation,
  useFilePicker,
  useUrlParam,
} from "@workspace/web-ui";
import { pillClasses } from "@workspace/format";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { stableCommandKey } from "@/lib/idempotent-command";
import { useSessionWork, type SessionWork } from "@/lib/use-session-work";
import {
  clearImportRun,
  executeImportRun,
  newImportRun,
  readImportRun,
  saveImportRun,
  type InvoiceImportRun,
} from "@/lib/invoice-import-run";
import { invoiceImportRunApi } from "@/lib/invoice-import-run-api";
import {
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  Upload,
  XCircle,
} from "lucide-react";
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

// Numbered step chip shared by the three cards (the readiness mark at card
// scale), so the import reads as one guided flow: add rows → validate →
// review what happened.
function StepMark({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`mi-card-icon text-xs font-bold ${done ? "" : "!bg-muted !text-muted-foreground"}`}
      data-tone={done ? "positive" : undefined}
      aria-hidden="true"
    >
      {done ? <CheckCircle2 /> : n}
    </span>
  );
}

const ROW_STATUS: Record<
  string,
  { label: string; tone: "emerald" | "red" | "slate" }
> = {
  valid: { label: "Valid", tone: "emerald" },
  created: { label: "Created", tone: "emerald" },
  invalid: { label: "Invalid", tone: "red" },
};

export function Import() {
  usePageTitle("Bulk import");
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importScope = me
    ? `${me.firmId}:${me.userId}:${me.clientPartyId}:import`
    : "";
  const operationKey = operationSessionKey(me);
  const captureWork = useSessionWork(operationKey);
  const [requestedRunId, setRequestedRunId] = useUrlParam("run");
  const requestedRunRef = useRef(requestedRunId);
  requestedRunRef.current = requestedRunId;
  const [activeRun, setActiveRun] = useState<InvoiceImportRun | null>(null);
  const activeRunRef = useRef<InvoiceImportRun | null>(null);
  const activeWork = useRef<SessionWork | null>(null);
  const fileVersion = useRef(0);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(true);
  const [readyScope, setReadyScope] = useState("");
  const importMut = useMutation({
    mutationKey: getImportInvoicesMutationOptions().mutationKey,
    mutationFn: async ({
      data,
      intent,
      work,
      journalKey,
    }: {
      data: Parameters<typeof importInvoices>[0];
      intent: InvoiceImportRun;
      work: SessionWork;
      journalKey: string | null;
    }) => {
      work.check();
      if (!data.commit) {
        const response = await importInvoices(data, { signal: work.signal });
        work.check();
        return response;
      }
      const api = invoiceImportRunApi(work.signal);
      return executeImportRun(
        intent,
        {
          ...api,
          commit: async (runId, index, chunkRows, idempotencyKey) => {
            work.check();
            const operation = beginOperation(journalKey, {
              title: `Import invoices, batch ${index + 1}`,
              kind: "import",
              route: `/import?run=${intent.id}`,
              command: "invoice.import",
              idempotencyKey,
            });
            try {
              work.check();
              const response = await api.commit(
                runId,
                index,
                chunkRows,
                idempotencyKey,
              );
              work.check();
              updateOperation(journalKey, operation?.id, {
                status: response.result.invalidCount
                  ? response.result.createdCount
                    ? "partial"
                    : "failed"
                  : "succeeded",
                savedSummary: `${response.result.createdCount} created, ${response.result.invalidCount} invalid.`,
              });
              return response;
            } catch (error) {
              if (!work.current()) throw error;
              updateOperation(journalKey, operation?.id, {
                status: "partial",
                savedSummary:
                  "Batch outcome unconfirmed. Resume this import with its original key.",
              });
              throw error;
            }
          },
        },
        (completed, total) => {
          work.check();
          setProgress({ completed, total });
        },
        work,
      );
    },
  });
  const running = useRef(false);

  const [raw, setRaw] = useState("");
  const [fileRows, setFileRows] = useState<InvoiceImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceImportResult | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const [commitInterrupted, setCommitInterrupted] = useState(false);

  useEffect(() => {
    if (!importScope) return;
    fileVersion.current++;
    const work = captureWork("restore");
    if (!work.current()) return;
    activeWork.current?.close();
    activeWork.current = null;
    running.current = false;
    const saved = readImportRun(importScope);
    const restored =
      !requestedRunRef.current || saved?.id === requestedRunRef.current
        ? saved
        : null;
    activeRunRef.current = restored;
    setActiveRun(restored);
    setFileRows(restored?.rows ?? null);
    setRaw("");
    setFileName(restored ? "Recovered import" : null);
    setResult(null);
    setProgress(null);
    setCommitInterrupted(
      restored ? restored.started : !!requestedRunRef.current,
    );
    setRecoverySaved(true);
    if (restored) setRequestedRunId(restored.id);
    setReadyScope(importScope);
    return () => {
      work.close();
      activeWork.current?.close();
    };
  }, [importScope, setRequestedRunId, captureWork]);

  const startNewImport = () => {
    if (running.current) return;
    const work = captureWork("new-import");
    if (!work.current()) return;
    activeWork.current?.close();
    activeWork.current = null;
    fileVersion.current++;
    clearImportRun(importScope);
    activeRunRef.current = null;
    setActiveRun(null);
    setRequestedRunId("");
    setRaw("");
    setFileRows(null);
    setFileName(null);
    setResult(null);
    setProgress(null);
    setCommitInterrupted(false);
    setRecoverySaved(true);
    work.close();
  };

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
    if (importMut.isPending || activeRun?.started) return;
    const version = ++fileVersion.current;
    const work = captureWork(
      `file:${version}`,
      () => version === fileVersion.current,
    );
    if (!work.current()) return;
    setResult(null);
    setCommitInterrupted(false);
    if (isLegacyExcel(file.name)) {
      toast({
        title: "Legacy .xls isn't supported",
        description: "Save the sheet as .xlsx or CSV and upload it again.",
        variant: "destructive",
      });
      work.close();
      return;
    }
    try {
      if (isExcel(file.name)) {
        const parsed = await parseWorkbook(file);
        work.check();
        setFileRows(parsed);
        setFileName(file.name);
        setRaw("");
      } else {
        const text = await file.text();
        work.check();
        setRaw(text);
        setFileRows(null);
        setFileName(null);
      }
    } catch {
      if (!work.current()) return;
      toast({
        title: "Could not read file",
        description: "Use the template's columns in the first sheet.",
        variant: "destructive",
      });
    } finally {
      work.close();
    }
  };

  const filePicker = useFilePicker(onFile);

  const run = async (commit: boolean) => {
    if (!me?.clientPartyId || rows.length === 0 || overCap || running.current)
      return;
    if (readyScope !== importScope) return;
    const version = fileVersion.current;
    const work = captureWork(
      activeRunRef.current?.id ?? (requestedRunId || crypto.randomUUID()),
      () =>
        activeWork.current === work &&
        fileVersion.current === version &&
        (!requestedRunRef.current || requestedRunRef.current === work.id),
    );
    activeWork.current = work;
    if (!work.current()) {
      work.close();
      activeWork.current = null;
      return;
    }
    const clientPartyId = me.clientPartyId;
    const sourceRows = structuredClone(rows);
    const sourceIntent = activeRunRef.current;
    const resumeId = requestedRunId;
    const api = invoiceImportRunApi(work.signal);
    running.current = true;
    setCommitInterrupted(false);
    const operation = commit
      ? undefined
      : beginOperation(operationKey, {
          title: commit ? "Import invoices" : "Validate invoice import",
          kind: "import",
          route: "/import",
          detail: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
        });
    try {
      const hash = await stableCommandKey(importScope, {
        clientPartyId,
        rows: sourceRows,
      });
      work.check();
      let intent = sourceIntent;
      if (!intent || intent.hash !== hash) {
        if (intent?.started)
          throw new Error(
            "This import already started. Resume its original rows or choose New import.",
          );
        const localPreviewId =
          intent && !intent.started && intent.id === resumeId
            ? intent.id
            : undefined;
        intent = await newImportRun(
          importScope,
          clientPartyId,
          sourceRows,
          work,
        );
        work.check();
        // Validation-only runs have no server manifest until their first commit.
        if (localPreviewId) {
          intent = {
            ...intent,
            id: localPreviewId,
            manifest: { ...intent.manifest, id: localPreviewId },
          };
        } else if (resumeId) {
          work.check();
          const remote = await api.get(resumeId);
          work.check();
          if (
            remote.clientPartyId !== intent.clientPartyId ||
            remote.totalRows !== intent.manifest.totalRows ||
            JSON.stringify(remote.chunkHashes) !==
              JSON.stringify(intent.manifest.chunkHashes)
          )
            throw new Error(
              "This file does not match the selected import. Upload its original file or start a New import.",
            );
          intent = {
            ...intent,
            id: resumeId,
            started: true,
            manifest: { ...intent.manifest, id: resumeId },
          };
        }
      }
      work.check();
      if (commit) intent = { ...intent, started: true };
      activeRunRef.current = intent;
      setActiveRun(intent);
      setRequestedRunId(intent.id);
      const persisted = saveImportRun(intent);
      setRecoverySaved(persisted);
      const res = await importMut.mutateAsync({
        data: { clientPartyId, commit, rows: sourceRows },
        intent: structuredClone(intent),
        work,
        journalKey: operationKey,
      });
      work.check();
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
      if (!work.current()) return;
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
              "Outcome unconfirmed. Retry this import with its original command key.",
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
      // A gateway/protocol failure can arrive after a successful commit too.
      const uncertain =
        commit &&
        ((errorStatus(e) ?? 0) >= 500 ||
          (errorStatus(e) ?? 0) < 400 ||
          errorStatus(e) === 408);
      if (commit) setCommitInterrupted(true);
      updateOperation(operationKey, operation?.id, {
        status: uncertain ? "partial" : "failed",
        detail: commit
          ? "The server rejected the import."
          : "Validation failed.",
        savedSummary: uncertain
          ? "Outcome unconfirmed. Retry the same import to reconcile."
          : "The server rejected this request.",
      });
      toast({
        title: commit ? "Import failed" : "Validation failed",
        description: commit
          ? `${serverErrorMessage(e)}${uncertain ? " The outcome is unconfirmed; retry the same import." : ""}`
          : serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      if (activeWork.current === work) {
        running.current = false;
        activeWork.current = null;
      }
      work.close();
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

  if (!importScope || readyScope !== importScope) {
    return (
      <div className="space-y-6">
        <PageHeader title="Bulk import" description={null} />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk import"
        description="Upload a spreadsheet of invoices — we validate every row before creating anything."
      />

      <RequireClientScope thing="bulk import">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5 text-base">
              <StepMark n={1} done={rows.length > 0 && !overCap} />
              Add your rows
            </CardTitle>
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
                disabled={
                  importMut.isPending ||
                  activeRun?.started ||
                  readyScope !== importScope
                }
                data-testid="button-upload"
              >
                <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> Upload
                Excel or CSV
              </Button>
              <Button
                variant="outline"
                onClick={startNewImport}
                disabled={importMut.isPending}
              >
                New import
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
                disabled={
                  importMut.isPending ||
                  activeRun?.started ||
                  readyScope !== importScope
                }
                onChange={(e) => {
                  fileVersion.current++;
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

        {activeRun && (
          <p role="status" className="text-sm text-muted-foreground">
            Import {activeRun.id}.{" "}
            {progress
              ? `${progress.completed} of ${progress.total} batches confirmed.`
              : activeRun.started
                ? "Ready to resume."
                : "Ready to validate."}
            {!recoverySaved &&
              " Device recovery is unavailable. Keep this tab open."}
          </p>
        )}

        <div className="space-y-3">
          <h2 className="flex items-center gap-2.5 text-base font-bold leading-snug">
            <StepMark n={2} done={!!result} />
            Validate and import
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
              The server has not confirmed the outcome. Retrying these unchanged
              rows reuses the same command key.{" "}
              <Link href="/invoices" className="font-medium underline">
                Check your Invoices list
              </Link>{" "}
              or reconcile this import now.
              {rows.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={importMut.isPending}
                  onClick={() => void run(true)}
                  className="mt-2"
                >
                  Resume this import
                </Button>
              ) : (
                <p className="mt-2">
                  Upload the original file to resume this import.
                </p>
              )}
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
              <CardTitle className="flex items-center gap-2.5 text-base">
                <StepMark n={3} done={result.committed} />
                {result.committed ? "Import results" : "Validation preview"}
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
                  icon={
                    <FileSpreadsheet className="size-4" aria-hidden="true" />
                  }
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
                  detail={
                    result.committed ? "Passed every check" : "Ready to import"
                  }
                  tone="positive"
                  icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
                />
                <Metric
                  label="Invalid"
                  value={
                    <>
                      <span aria-hidden="true">{result.invalidCount}</span>
                      <span
                        className="sr-only"
                        data-testid="text-invalid-count"
                      >
                        Invalid: {result.invalidCount}
                      </span>
                    </>
                  }
                  detail={
                    result.invalidCount > 0
                      ? "Fix and re-import"
                      : "Nothing to fix"
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
                        <span
                          className="sr-only"
                          data-testid="text-created-count"
                        >
                          Created: {result.createdCount}
                        </span>
                      </>
                    }
                    detail="Saved as drafts"
                    tone="info"
                    icon={
                      <ClipboardCheck className="size-4" aria-hidden="true" />
                    }
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
                                    <span className="font-semibold">
                                      {e.field}
                                    </span>
                                    : {e.message}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
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
        )}
      </RequireClientScope>
    </div>
  );
}
