import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Download, Upload } from "lucide-react";
import { TEMPLATE, download, downloadExcelTemplate } from "./helpers";
import { StepMark } from "./step-mark";
import type { ImportRunState } from "./use-import-run";

/** Step 1 — the drop zone, the file/template buttons and the CSV textarea. */
export function AddRowsCard({
  rows,
  overCap,
  duplicateNumbers,
  raw,
  editRaw,
  fileName,
  filePicker,
  pending,
  activeRun,
  readyScope,
  importScope,
  startNewImport,
}: Pick<
  ImportRunState,
  | "rows"
  | "overCap"
  | "duplicateNumbers"
  | "raw"
  | "editRaw"
  | "fileName"
  | "filePicker"
  | "activeRun"
  | "readyScope"
  | "importScope"
  | "startNewImport"
> & { pending: boolean }) {
  return (
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
              pending || activeRun?.started || readyScope !== importScope
            }
            data-testid="button-upload"
          >
            <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> Upload Excel
            or CSV
          </Button>
          <Button variant="outline" onClick={startNewImport} disabled={pending}>
            New import
          </Button>
          <Button
            variant="ghost"
            onClick={() => download("valo-template.csv", TEMPLATE)}
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
          CSV or Excel (.xlsx, first sheet) with the template’s columns — up to
          5,000 rows per import. You can also drag and drop your file anywhere
          on this card.
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
              pending || activeRun?.started || readyScope !== importScope
            }
            onChange={(e) => editRaw(e.target.value)}
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
          <p className="text-sm text-destructive" data-testid="text-over-cap">
            {rows.length.toLocaleString()} rows is over the 5,000-row limit —
            split the file and import it in batches.
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
            . Each repeat is imported as a separate draft with the same number —
            renumber or remove the repeats before importing.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
