import {
  useGetFilingMatrix,
  getGetFilingMatrixQueryKey,
} from "@workspace/api-client-react";
import type { FilingMatrixRow } from "@workspace/api-client-react";
import {
  filingKindLabel,
  filingStatusLabel,
} from "@workspace/format/filing-copy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";

// Filing cockpit (Filing Desk phase 3): the firm-wide grid of the current
// period's returns — one row per client, one cell per return kind (the VAT
// return, the PAYE remittance and the WHT remittance), each cell reading
// the client's own register status. The 21st-of-the-month question — "who
// has filed, who hasn't?" — answered in one screen, from the same rows each
// client's filings register walks, so the two can never disagree.
//
// Render-on-success like the VAT positions card beside it: a 403 for roles
// without the capability (or a 404 from an older server build) simply hides
// the card, and a firm with no clients has no cockpit to show.

// ---- Pure helpers (unit-tested directly) -----------------------------------

/**
 * A cell's words. For vat/paye, null means the register has not minted this
 * period's row for that client yet (the client isn't engaged for the kind,
 * or sync hasn't run) — "Not minted", distinct from an upcoming-but-tracked
 * return. For wht, null is the COMMON cell — the client withheld nothing in
 * the period, so no remittance is owed — and reads the honest "No duty"
 * (per the contract's FilingMatrixRow comment), never "Not minted". Every
 * real status speaks the shared filing-copy vocabulary.
 */
export function matrixCellLabel(
  status: string | null,
  kind: "vat" | "paye" | "wht" = "vat",
): string {
  if (status === null) return kind === "wht" ? "No duty" : "Not minted";
  return filingStatusLabel(status);
}

/**
 * A row's urgency bucket for the sort: 0 = something is unstarted (any cell
 * null or "upcoming"), 1 = work in flight (no unstarted cell, any cell
 * "prepared"), 2 = done (all cells filed). A null WHT cell is the
 * no-withholding-duty case, not unstarted work, so it drops out of the read
 * entirely — a minted WHT row counts like any other. An off-catalogue
 * status from a newer server lands in the done bucket rather than crashing
 * the sort.
 */
function rowUrgency(row: Pick<FilingMatrixRow, "vat" | "paye" | "wht">): number {
  const cells = [row.vat, row.paye, ...(row.wht === null ? [] : [row.wht])];
  if (cells.some((c) => c === null || c === "upcoming")) return 0;
  if (cells.some((c) => c === "prepared")) return 1;
  return 2;
}

/**
 * Table order: unfiled-most-urgent first — rows with anything not yet
 * started (a null or "upcoming" cell) lead, rows mid-preparation follow,
 * all-filed rows sink to the bottom — with a stable client-name tiebreak
 * inside each bucket. Non-mutating.
 */
export function sortMatrixRows(
  rows: readonly FilingMatrixRow[],
): FilingMatrixRow[] {
  return [...rows].sort((a, b) => {
    const diff = rowUrgency(a) - rowUrgency(b);
    if (diff !== 0) return diff;
    return a.clientName.localeCompare(b.clientName);
  });
}

// Cell tones are deliberately console-local (the filings-card pill palette):
// emerald a filed return, blue the prepared intermediate, slate an upcoming
// one, and a muted italic for a row the register hasn't minted.
function matrixCellClass(status: string | null): string {
  if (status === null) return "italic text-muted-foreground";
  if (status === "filed") return "text-emerald-600 dark:text-emerald-400";
  if (status === "prepared") return "text-blue-600 dark:text-blue-400";
  return "text-slate-600 dark:text-slate-400";
}

// ---- The card ---------------------------------------------------------------

export function FilingMatrixCard() {
  const { data, isSuccess } = useGetFilingMatrix({
    query: { queryKey: getGetFilingMatrixQueryKey(), retry: false },
  });
  if (!isSuccess || !data) return null;
  // A firm with no clients has no cockpit — no card, not an empty grid.
  if (data.rows.length === 0) return null;
  const rows = sortMatrixRows(data.rows);
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-filing-matrix"
    >
      <CardHeader>
        {/* periodLabel comes from the server verbatim — the same wording the
            registers show, never re-derived here. */}
        <CardTitle className="text-base">
          Filing cockpit — {data.periodLabel}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {filingKindLabel("vat")} due {formatDate(data.dueDates.vat)} ·{" "}
          {filingKindLabel("paye")} due {formatDate(data.dueDates.paye)} ·{" "}
          {filingKindLabel("wht")} due {formatDate(data.dueDates.wht)}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-filing-matrix">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Client</th>
                <th className="py-2 pr-3 font-medium">
                  {filingKindLabel("vat")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {filingKindLabel("paye")}
                </th>
                <th className="py-2 font-medium">{filingKindLabel("wht")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr
                  key={r.clientPartyId}
                  data-testid={`row-filing-matrix-${r.clientPartyId}`}
                >
                  <td className="py-2 pr-3 max-w-[16rem] truncate">
                    {r.clientName}
                  </td>
                  <td
                    className={`py-2 pr-3 ${matrixCellClass(r.vat)}`}
                    data-testid={`cell-filing-vat-${r.clientPartyId}`}
                  >
                    {matrixCellLabel(r.vat)}
                  </td>
                  <td
                    className={`py-2 pr-3 ${matrixCellClass(r.paye)}`}
                    data-testid={`cell-filing-paye-${r.clientPartyId}`}
                  >
                    {matrixCellLabel(r.paye, "paye")}
                  </td>
                  <td
                    className={`py-2 ${matrixCellClass(r.wht)}`}
                    data-testid={`cell-filing-wht-${r.clientPartyId}`}
                  >
                    {/* null = no withholding duty this period (the common
                        cell), so it reads "No duty", not "Not minted". */}
                    {matrixCellLabel(r.wht, "wht")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p
          className="text-sm font-medium"
          data-testid="text-filing-matrix-totals"
        >
          {data.totals.clients} clients · {data.totals.filed} filed ·{" "}
          {data.totals.unfiled} unfiled ·{" "}
          <span
            className={
              data.totals.overdue > 0 ? "text-red-600 dark:text-red-400" : ""
            }
          >
            {data.totals.overdue} overdue
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Evidence only — the cockpit reads each client's filings register as
          the firm recorded it; the platform never files anything itself.
        </p>
      </CardContent>
    </Card>
  );
}
