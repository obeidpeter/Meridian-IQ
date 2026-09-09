import {
  getGetRejectionPatternsQueryKey,
  useGetRejectionPatterns,
  useGetFirmComplianceCalendar,
  getGetFirmComplianceCalendarQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollRegion } from "@/components/scroll-region";
import {
  FileWarning,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { calendarHasContent, rejectionsHaveContent } from "./helpers";

// Firm-level compliance calendar (round-6 idea #5): the month-ahead view of
// the same statutory clocks each client's dashboard shows — same constants,
// same Lagos-calendar predicates server-side, so this card can never
// disagree with what a client sees.
export function ComplianceCalendarCard() {
  const { data: calendar, isSuccess } = useGetFirmComplianceCalendar({
    query: { queryKey: getGetFirmComplianceCalendarQueryKey(), retry: false },
  });
  // Same predicate the page's section-occupancy check uses, so the card and
  // the section can never disagree about a quiet calendar.
  if (!isSuccess || !calendarHasContent(calendar)) return null;
  return (
    <Card className="shadow-sm" data-testid="card-compliance-calendar">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-4 h-4 text-primary" aria-hidden="true" />
          Compliance calendar — next {calendar.horizonDays} days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {calendar.overdue.invoices > 0 && (
          <div
            className="rounded-md border border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40 px-3 py-2 text-sm text-red-900 dark:text-red-200"
            data-testid="calendar-overdue"
          >
            {calendar.overdue.invoices} unsubmitted invoice(s) across{" "}
            {calendar.overdue.clients} client(s) are already past their
            submission window.
          </div>
        )}
        {calendar.days.map((day) => (
          <div
            key={day.date}
            className="flex items-start gap-3 text-sm border-b last:border-b-0 pb-2 last:pb-0"
            data-testid={`calendar-day-${day.date}`}
          >
            <span className="font-medium tabular-nums shrink-0 w-28">
              {formatDate(day.date)}
            </span>
            <div className="min-w-0 space-y-0.5">
              {day.events.map((e, i) => (
                <p
                  key={i}
                  className={
                    e.kind === "vat_return"
                      ? "font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {e.label}
                </p>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Same statutory clocks as each client's dashboard (Lagos calendar) —
          submission windows and VAT filing dates, computed live. No AI
          involved.
        </p>
      </CardContent>
    </Card>
  );
}

// Rejection-pattern report (round-4 idea #3): the firm's recurring rejection
// causes, catalogue-grounded, with a prior-window trend. Renders only on
// success and only when there is something to show — a quiet firm sees no
// card, not an empty table.
export function RejectionPatternsCard() {
  const { data: report, isSuccess } = useGetRejectionPatterns({
    query: { queryKey: getGetRejectionPatternsQueryKey(), retry: false },
  });
  // Same predicate the page's section-occupancy check uses, so the card and
  // the section can never disagree about a quiet firm.
  if (!isSuccess || !rejectionsHaveContent(report)) return null;
  const trend = (count: number, previous: number) =>
    count > previous ? (
      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
        <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
        {count - previous > 0 ? `+${count - previous}` : ""}
      </span>
    ) : count < previous ? (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />−
        {previous - count}
      </span>
    ) : (
      <Minus className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
    );
  return (
    <Card className="shadow-sm" data-testid="card-rejection-patterns">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileWarning className="w-4 h-4 text-primary" aria-hidden="true" />
          Recurring rejection causes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ScrollRegion label="Recurring rejection causes table">
          <table
            className="w-full text-sm"
            data-testid="table-rejection-patterns"
          >
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Last {report.windowDays}d
                </th>
                <th className="py-2 pr-3 font-medium text-right">Trend</th>
                <th className="py-2 pr-3 font-medium text-right">Clients</th>
                <th className="py-2 font-medium">Fix</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.rows.slice(0, 8).map((r) => (
                <tr
                  key={r.errorCode}
                  data-testid={`row-rejection-${r.errorCode}`}
                >
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs">{r.errorCode}</span>
                    {r.category && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {r.category}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.count}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {trend(r.count, r.previousCount)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.clientCount}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground max-w-[22rem]">
                    {r.fix ??
                      "Not in the catalogue yet — draft an entry from the catalogue page."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
        <p className="text-xs text-muted-foreground">
          Rejected submission attempts in the last {report.windowDays} days (
          {report.totalRejections}) against the {report.windowDays} before (
          {report.previousTotal}). Computed from your own submission history —
          no AI involved.
        </p>
      </CardContent>
    </Card>
  );
}
