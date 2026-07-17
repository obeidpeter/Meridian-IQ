import { useMemo, useState } from "react";
import {
  useImportClients,
  useDraftClientImportWithClerk,
  type ClientImportRow,
  type ClientImportResult,
  type ClientImportDraft,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { StatTile } from "@/components/stat-tile";
import { isFeatureDisabled } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { importRowBadgeClasses, importRowLabel } from "@/lib/format";
import { useFilePicker } from "@workspace/web-ui";
import {
  Upload,
  Download,
  CheckCircle2,
  XCircle,
  Copy,
  Users,
  Sparkles,
} from "lucide-react";

const COLUMNS = [
  "legalName",
  "tin",
  "cacNumber",
  "email",
  "street",
  "city",
] as const;

const TEMPLATE =
  COLUMNS.join(",") +
  "\n" +
  'Adaeze Foods Ltd,12345678-0001,RC123456,ops@adaezefoods.ng,"12, Allen Avenue",Ikeja';

// Minimal RFC-4180 CSV parser: practice-management exports quote fields that
// contain commas (addresses, legal names), so a naive split(",") corrupts them.
function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseClientRows(text: string): ClientImportRow[] {
  const table = parseCsvTable(text);
  if (table.length < 2) return [];
  const header = table[0].map((h) => h.trim());
  return table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((h, i) => {
      record[h] = (cells[i] ?? "").trim();
    });
    const optional = (key: string) => record[key] || undefined;
    return {
      legalName: record.legalName ?? "",
      tin: optional("tin"),
      cacNumber: optional("cacNumber"),
      email: optional("email"),
      street: optional("street"),
      city: optional("city"),
    };
  });
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ClientImport() {
  usePageTitle("Client import");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importClients = useImportClients();
  const clerkDraft = useDraftClientImportWithClerk();

  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ClientImportResult | null>(null);
  const [draft, setDraft] = useState<ClientImportDraft | null>(null);
  const [featureDark, setFeatureDark] = useState(false);

  const pastedRows = useMemo(() => parseClientRows(raw), [raw]);
  // A Clerk draft supersedes the strict-template parse: its rows already went
  // through the header-verified mapping, so they feed the SAME validate/commit
  // flow — nothing is created until the ordinary import commit.
  const rows = draft ? draft.rows : pastedRows;

  const onFile = async (file: File) => {
    setResult(null);
    setDraft(null);
    setRaw(await file.text());
    setFileName(file.name);
  };
  const filePicker = useFilePicker(onFile);

  // The pasted text is in OUR template exactly when every row has a legalName
  // after a strict-header parse; anything else (practice-management exports,
  // renamed headers) is what the Clerk mapping is for.
  const looksLikeTemplate =
    pastedRows.length > 0 && pastedRows.every((r) => r.legalName.trim() !== "");

  const draftWithClerk = () => {
    clerkDraft.mutate(
      { data: { sampleCsv: raw } },
      {
        onSuccess: (res) => {
          setDraft(res);
          setResult(null);
          toast({
            title: "Draft ready",
            description: `${res.rows.length} row(s) mapped from your file — review, then validate.`,
          });
        },
        onError: () =>
          toast({
            title: "Clerk could not map that file",
            description:
              "Check the sample includes a header row naming the client column, or reshape it to the CSV template.",
            variant: "destructive",
          }),
      },
    );
  };

  const run = async (commit: boolean) => {
    if (rows.length === 0) return;
    try {
      const res = await importClients.mutateAsync({ data: { rows, commit } });
      setResult(res);
      if (commit) {
        await queryClient.invalidateQueries();
        toast({
          title: "Import complete",
          description: `${res.createdCount} client(s) created.`,
        });
      } else {
        toast({
          title: "Validation done",
          description: `${res.createdCount} new, ${res.existsCount} existing, ${res.invalidCount} invalid.`,
        });
      }
    } catch (err) {
      if (isFeatureDisabled(err)) {
        setFeatureDark(true);
        return;
      }
      toast({
        title: commit ? "Import failed" : "Validation failed",
        description:
          err instanceof Error ? err.message : "Please check your rows.",
        variant: "destructive",
      });
    }
  };

  if (featureDark) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Client import
        </h1>
        <FeatureUnavailable feature="Bulk client import" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Client import
        </h1>
        <p className="text-muted-foreground mt-1">
          Move a client book across from your practice-management export. Every
          row is validated before anything is created.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Add your rows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              {...filePicker.inputProps}
            />
            <Button
              variant="outline"
              onClick={filePicker.openPicker}
              data-testid="button-upload"
            >
              <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> Upload CSV
            </Button>
            <Button
              variant="ghost"
              onClick={() => download("meridianiq-clients-template.csv", TEMPLATE)}
              data-testid="button-template"
            >
              <Download className="w-4 h-4 mr-2" aria-hidden="true" /> CSV template
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-csv">
              Or paste CSV rows (first line = {COLUMNS.join(",")})
            </Label>
            <Textarea
              id="import-csv"
              className="min-h-[140px] font-mono text-sm"
              placeholder={TEMPLATE}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setFileName(null);
                setResult(null);
                setDraft(null);
              }}
              data-testid="input-csv"
            />
          </div>
          {rows.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-rows-ready">
              {fileName ? (
                <>
                  Loaded <span className="font-medium">{fileName}</span> —{" "}
                </>
              ) : null}
              {rows.length} row{rows.length === 1 ? "" : "s"} ready
              {draft ? " (mapped by Clerk)" : ""}.
            </p>
          )}
          {raw.trim().length >= 20 && !looksLikeTemplate && !draft && (
            <div className="rounded-md border border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/40 p-3 space-y-2">
              <p className="text-sm text-violet-900 dark:text-violet-200">
                Headers don't match the template? Clerk can map your
                practice-management export's columns — you review the mapping
                before anything is validated or created.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={draftWithClerk}
                disabled={clerkDraft.isPending || raw.length > 20000}
                data-testid="button-clerk-draft-import"
              >
                <Sparkles className="w-4 h-4 mr-1.5" aria-hidden="true" />
                {clerkDraft.isPending ? "Mapping…" : "Draft with Clerk"}
              </Button>
              {raw.length > 20000 && (
                <p className="text-xs text-violet-900/70 dark:text-violet-200/70">
                  The file is too large for Clerk mapping (20,000 character
                  cap) — reshape it to the CSV template instead.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {draft && (
        <Card data-testid="card-clerk-mapping">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
              Clerk's column mapping
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {Object.entries(draft.columns).map(([target, source]) => (
                <p key={target} className="text-sm">
                  <span className="font-medium">{target}</span>{" "}
                  <span className="text-muted-foreground">
                    ← {source ?? "(not in the file)"}
                  </span>
                </p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="text-mapping-stats">
              Parsed {draft.validation.parsedCount} of{" "}
              {draft.validation.lineCount} data row
              {draft.validation.lineCount === 1 ? "" : "s"} under this mapping.
              Every row still goes through the ordinary validate-then-commit
              checks below.
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setResult(null);
              }}
              data-testid="button-discard-mapping"
            >
              Discard mapping
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => run(false)}
          disabled={rows.length === 0 || importClients.isPending}
          data-testid="button-validate"
        >
          <CheckCircle2 className="w-4 h-4 mr-2" aria-hidden="true" /> Validate rows
        </Button>
        <Button
          onClick={() => run(true)}
          disabled={
            rows.length === 0 ||
            importClients.isPending ||
            !result ||
            result.committed
          }
          data-testid="button-commit"
        >
          <Users className="w-4 h-4 mr-2" aria-hidden="true" />
          {importClients.isPending ? "Working…" : "Commit import"}
        </Button>
        {!result && rows.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Validate first — commit unlocks after a validation pass.
          </p>
        )}
      </div>

      {importClients.isPending && !result && <Skeleton className="h-40" />}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="Total rows"
              value={result.rowCount}
              testId="stat-total"
            />
            <StatTile
              label={result.committed ? "Created" : "Would create"}
              value={result.createdCount}
              tone="success"
              testId="stat-created"
            />
            <StatTile
              label="Already exist"
              value={result.existsCount}
              tone="warning"
              testId="stat-exists"
            />
            <StatTile
              label="Invalid"
              value={result.invalidCount}
              tone="danger"
              testId="stat-invalid"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {result.committed ? "Import results" : "Validation preview"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.rows.map((r) => {
                const source = rows[r.rowNumber - 1];
                return (
                  <div
                    key={r.rowNumber}
                    className="flex items-start gap-2 text-sm border rounded-md px-3 py-2"
                    data-testid={`row-result-${r.rowNumber}`}
                  >
                    {r.status === "invalid" ? (
                      <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
                    ) : r.status === "exists" ? (
                      <Copy className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">
                          Row {r.rowNumber}
                          {source?.legalName ? ` · ${source.legalName}` : ""}
                        </p>
                        <span className={importRowBadgeClasses(r.status)}>
                          {importRowLabel(r.status)}
                        </span>
                      </div>
                      {(r.errors ?? []).length > 0 && (
                        <ul className="text-xs text-destructive mt-1 space-y-0.5">
                          {(r.errors ?? []).map((e, i) => (
                            <li key={i}>
                              {e.field}: {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
