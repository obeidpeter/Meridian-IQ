import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  useGetMe,
  useImportInvoices,
  type InvoiceImportRow,
  type InvoiceImportResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const COLUMNS = [
  "invoiceNumber",
  "buyerName",
  "buyerTin",
  "issueDate",
  "dueDate",
  "description",
  "quantity",
  "unitPrice",
  "vatRate",
  "currency",
] as const;

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

function downloadExcelTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    [...COLUMNS],
    [
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
    ],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  XLSX.writeFile(wb, "meridianiq-template.xlsx");
}

function mapRow(row: Record<string, unknown>, idx: number): InvoiceImportRow {
  const cell = (k: string) => {
    const v = row[k];
    return v === undefined || v === null ? "" : String(v).trim();
  };
  return {
    rowNumber: idx + 1,
    invoiceNumber: cell("invoiceNumber"),
    buyerName: cell("buyerName"),
    buyerTin: cell("buyerTin"),
    issueDate: cell("issueDate"),
    dueDate: cell("dueDate"),
    description: cell("description"),
    quantity: cell("quantity"),
    unitPrice: cell("unitPrice"),
    vatRate: cell("vatRate"),
    currency: cell("currency"),
  } as InvoiceImportRow;
}

function parseCsv(text: string): InvoiceImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line, idx) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] || "").trim();
    });
    return mapRow(row, idx);
  });
}

// Parse the first sheet of an Excel workbook (.xlsx/.xls). Header row must use
// the same canonical column names as the CSV template so both formats map to the
// identical import-row model and run through the same server-side validator.
function parseWorkbook(data: ArrayBuffer): InvoiceImportRow[] {
  const wb = XLSX.read(data, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  return json.map((row, idx) => mapRow(row, idx));
}

function isExcel(name: string): boolean {
  return /\.xlsx?$/i.test(name);
}

export function Import() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importMut = useImportInvoices();
  const fileRef = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState("");
  const [fileRows, setFileRows] = useState<InvoiceImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceImportResult | null>(null);

  const rows = useMemo(
    () => fileRows ?? parseCsv(raw),
    [fileRows, raw],
  );

  const onFile = async (file: File) => {
    setResult(null);
    try {
      if (isExcel(file.name)) {
        const buf = await file.arrayBuffer();
        const parsed = parseWorkbook(buf);
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
        await queryClient.invalidateQueries();
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
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bulk Import</h1>
        <p className="text-muted-foreground">
          Upload a spreadsheet of invoices — we validate every row before creating anything.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Add your rows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" /> Upload Excel or CSV
            </Button>
            <Button
              variant="ghost"
              onClick={() => download("meridianiq-template.csv", TEMPLATE)}
            >
              <Download className="w-4 h-4 mr-2" /> CSV template
            </Button>
            <Button variant="ghost" onClick={downloadExcelTemplate}>
              <Download className="w-4 h-4 mr-2" /> Excel template
            </Button>
          </div>
          <textarea
            className="w-full min-h-[140px] rounded-md border border-input bg-transparent p-3 text-sm font-mono"
            placeholder="…or paste CSV rows here (first line = column headers)"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setFileRows(null);
              setFileName(null);
              setResult(null);
            }}
          />
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
          onClick={() => run(true)}
          disabled={rows.length === 0 || importMut.isPending}
        >
          <FileSpreadsheet className="w-4 h-4 mr-2" />
          {importMut.isPending ? "Working…" : "Import valid rows"}
        </Button>
      </div>

      {result && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {result.committed ? "Import results" : "Validation preview"}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={downloadResults}>
              <Download className="w-4 h-4 mr-2" /> Download
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>Total: {result.total}</span>
              <span className="text-emerald-700">Valid: {result.validCount}</span>
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
                    <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium">
                      Row {r.rowNumber}
                      {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}{" "}
                      <span className="capitalize text-muted-foreground font-normal">
                        ({r.status})
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
    </div>
  );
}
