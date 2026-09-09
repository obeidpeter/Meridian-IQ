import { useState } from "react";
import {
  useGetQuarterlyReview,
  getGetQuarterlyReviewQueryKey,
  useDraftQuarterlyCoverNote,
  type QuarterlyReviewCoverNote,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/stat-tile";
import { ScrollRegion } from "@/components/scroll-region";
import { Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatNaira } from "@/lib/format";
import { formatMoney } from "./format";
import { CoverNotePanel, coverNoteHandlers } from "./cover-note";

// Quarterly review pack (round-13 idea #4): the closed quarter's monthly VAT
// packs, submission outcomes, rejection causes, receivables snapshot and
// Clerk throughput — one deterministic document for the quarterly client-book
// conversation, with an optional phrased cover note (digest posture).
export function QuarterlyReviewCard() {
  const { toast } = useToast();
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const params = quarter ? { quarter } : undefined;
  const { data: review, isSuccess } = useGetQuarterlyReview(params, {
    query: { queryKey: getGetQuarterlyReviewQueryKey(params), retry: false },
  });

  const coverNote = useDraftQuarterlyCoverNote();
  const [note, setNote] = useState<QuarterlyReviewCoverNote | null>(null);
  const [noteText, setNoteText] = useState("");

  if (!isSuccess || !review) return null;
  const quarterShort = (q: string) => {
    const [y, m] = q.split("-");
    return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`;
  };
  return (
    <Card className="shadow-sm" data-testid="card-quarterly-review">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Quarterly review — {review.quarterLabel}</span>
          <span className="flex items-center gap-2">
            <Select
              value={review.quarterStart}
              onValueChange={(q) => {
                setQuarter(q);
                setNote(null);
              }}
            >
              <SelectTrigger
                className="h-8 w-28 text-xs"
                data-testid="select-quarterly-quarter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {review.quarters.map((q) => (
                  <SelectItem key={q} value={q}>
                    {quarterShort(q)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={coverNote.isPending}
              onClick={() =>
                coverNote.mutate(
                  { data: { quarter: review.quarterStart } },
                  coverNoteHandlers<QuarterlyReviewCoverNote>(
                    setNote,
                    setNoteText,
                    toast,
                  ),
                )
              }
              data-testid="button-quarterly-cover-note"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {coverNote.isPending ? "Drafting…" : "Cover note"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ScrollRegion label="Quarterly VAT months table">
          <table
            className="w-full text-sm"
            data-testid="table-quarterly-months"
          >
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Month</th>
                <th className="py-2 pr-3 font-medium text-right">Accepted</th>
                <th className="py-2 pr-3 font-medium text-right">Output VAT</th>
                <th className="py-2 pr-3 font-medium text-right">Credits</th>
                <th className="py-2 font-medium text-right">Net VAT</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {review.months.map((m) => (
                <tr key={m.monthStart}>
                  <td className="py-2 pr-3">{m.monthLabel}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {m.acceptedCount}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(m.acceptedVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {Number(m.creditVat) > 0
                      ? `−${formatNaira(m.creditVat)}`
                      : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatNaira(m.netVat)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-3">Quarter</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {review.vatTotals.acceptedCount}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatNaira(review.vatTotals.acceptedVat)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {Number(review.vatTotals.creditVat) > 0
                    ? `−${formatNaira(review.vatTotals.creditVat)}`
                    : "—"}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatNaira(review.vatTotals.netVat)}
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollRegion>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Submissions accepted"
            value={`${review.submissions.accepted}`}
            testId="tile-quarterly-accepted"
          />
          <StatTile
            label="Rejected"
            value={`${review.rejectionTotal}`}
            detail={
              review.topRejections.length > 0
                ? review.topRejections
                    .slice(0, 2)
                    .map((r) => `${r.errorCode} ×${r.count}`)
                    .join(" · ")
                : undefined
            }
            testId="tile-quarterly-rejected"
          />
          <StatTile
            label="Receivables today"
            value={
              review.receivables.groups.length > 0
                ? formatMoney(
                    review.receivables.groups[0].outstandingTotal,
                    review.receivables.groups[0].currency,
                  )
                : "—"
            }
            detail={
              review.receivables.groups.length > 1
                ? `+ ${review.receivables.groups.length - 1} more currenc${review.receivables.groups.length > 2 ? "ies" : "y"}`
                : undefined
            }
            testId="tile-quarterly-receivables"
          />
          <StatTile
            label="Clerk captures"
            value={`${review.clerk.captures}`}
            detail={`${review.clerk.approved} approved`}
            testId="tile-quarterly-clerk"
          />
        </div>
        <p className="text-xs text-muted-foreground">{review.note}</p>
        {note && (
          <CoverNotePanel
            periodLabel={note.quarterLabel}
            source={note.source}
            destinationWord="letter"
            text={noteText}
            onChange={setNoteText}
            onDiscard={() => setNote(null)}
            testIds={{
              panel: "quarterly-cover-note",
              input: "input-quarterly-cover-note",
              copy: "button-copy-quarterly-note",
              discard: "button-discard-quarterly-note",
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
