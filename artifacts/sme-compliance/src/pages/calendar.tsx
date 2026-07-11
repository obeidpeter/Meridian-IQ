import { Link } from "wouter";
import {
  useGetMe,
  useGetComplianceCalendar,
  getGetComplianceCalendarQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import { CalendarClock, AlertTriangle, ChevronRight } from "lucide-react";
import { formatDate, severityBadgeClasses } from "@/lib/format";

function daysAway(due: string): string | null {
  const ms = new Date(due).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = Math.round((ms - Date.now()) / (24 * 60 * 60 * 1000));
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} overdue`;
  if (diff === 0) return "Due today";
  return `In ${diff} day${diff === 1 ? "" : "s"}`;
}

export function Calendar() {
  usePageTitle("Calendar");
  const { data: me } = useGetMe();
  const {
    data: deadlines,
    isLoading,
    isError,
    refetch,
  } = useGetComplianceCalendar(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetComplianceCalendarQueryKey({
          clientPartyId: me?.clientPartyId || "",
        }),
      },
    },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Compliance calendar
          </h1>
          <p className="text-muted-foreground mt-1">
            Filing deadlines and penalty watch, computed from your invoice book.
          </p>
        </div>
      </div>

      <RequireClientScope thing="compliance calendar">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : isError ? (
          <QueryError thing="your compliance calendar" onRetry={() => refetch()} />
        ) : !deadlines || deadlines.length === 0 ? (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center gap-2">
              <CalendarClock className="w-10 h-10 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold" data-testid="text-empty">
                Nothing due right now
              </p>
              <p className="text-sm text-muted-foreground">
                You're all caught up on filings. New deadlines appear here as
                invoices are stamped and reporting windows open.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {deadlines.map((d) => {
              const relative = daysAway(d.dueDate);
              return (
              <Card
                key={d.id}
                className={d.status === "overdue" ? "border-destructive/40" : ""}
              >
                <CardContent className="flex items-start justify-between gap-3 p-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5">
                      {d.status === "overdue" ? (
                        <AlertTriangle className="w-5 h-5 text-destructive" aria-hidden="true" />
                      ) : (
                        <CalendarClock className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold">{d.title}</p>
                      {d.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {d.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {relative && (
                          <span className={severityBadgeClasses(d.severity)}>
                            {relative}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          Due {formatDate(d.dueDate)}
                        </span>
                      </div>
                    </div>
                  </div>
                  {d.invoiceId && (
                    <Link
                      href={`/invoices/${d.invoiceId}`}
                      className="text-primary text-sm inline-flex items-center shrink-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      Open <ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </Link>
                  )}
                </CardContent>
              </Card>
              );
            })}
          </div>
        )}
      </RequireClientScope>
    </div>
  );
}
