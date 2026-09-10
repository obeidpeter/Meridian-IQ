import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGetMe,
  getImportInvoicesMutationOptions,
  importInvoices,
  type InvoiceImportRow,
  type InvoiceImportResult,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
  useFilePicker,
  useUrlParam,
} from "@workspace/web-ui";
import { stableCommandKey } from "@/lib/idempotent-command";
import { useSessionWork, type SessionWork } from "@/lib/use-session-work";
import {
  clearImportRun,
  executeImportRun,
  readImportRun,
  saveImportRun,
  type InvoiceImportRun,
} from "@/lib/invoice-import-run";
import { invoiceImportRunApi } from "@/lib/invoice-import-run-api";
import { csvCell } from "@workspace/web-ui/csv";
import { COLUMNS, parseCsv, isExcel, isLegacyExcel } from "../import-parse";
import { MAX_IMPORT_ROWS, download, parseWorkbook } from "./helpers";
import {
  beginImportOperation,
  reportImportFailure,
  reportImportSuccess,
  resolveImportIntent,
} from "./run-flow";

/**
 * Every hook, ref, mutation and handler of the bulk-import page, in the
 * order the page has always called them (R126 split). `run` keeps its
 * guards, work capture and work.check() positions; the stages between them
 * live in ./run-flow.
 */
export function useImportRun() {
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
    const operation = beginImportOperation(commit, operationKey, rows.length);
    try {
      const hash = await stableCommandKey(importScope, {
        clientPartyId,
        rows: sourceRows,
      });
      work.check();
      let intent = await resolveImportIntent({
        sourceIntent,
        hash,
        importScope,
        clientPartyId,
        sourceRows,
        resumeId,
        work,
        api,
      });
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
      reportImportSuccess({
        res,
        commit,
        operation,
        operationKey,
        queryClient,
        toast,
      });
    } catch (e) {
      if (!work.current()) return;
      reportImportFailure({
        e,
        commit,
        operation,
        operationKey,
        toast,
        setCommitInterrupted,
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

  // The CSV textarea's edit: a new file version, and every derived state
  // (parsed file rows, file name, result, interrupted flag) is dropped.
  const editRaw = (value: string) => {
    fileVersion.current++;
    setRaw(value);
    setFileRows(null);
    setFileName(null);
    setResult(null);
    setCommitInterrupted(false);
  };

  return {
    importScope,
    readyScope,
    rows,
    overCap,
    duplicateNumbers,
    raw,
    editRaw,
    fileName,
    filePicker,
    importMut,
    activeRun,
    progress,
    recoverySaved,
    startNewImport,
    run,
    result,
    knownInvalidCount,
    confirmCommit,
    setConfirmCommit,
    onCommitClick,
    commitInterrupted,
    downloadResults,
    downloadFailedRows,
  };
}

export type ImportRunState = ReturnType<typeof useImportRun>;
