import { Link } from "wouter";
import { useGetMe, useGetComplianceCalendar, getGetComplianceCalendarQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarClock, AlertTriangle, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/format";

const SEVERITY: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-amber-100 text-amber-800 border-amber-200",
  info: "bg-blue-100 text-blue-800 border-blue-200",
};

function daysAway(due: string): string {
  const diff = Math.round(
    (new Date(due).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} overdue`;
  if (diff === 0) return "Due today";
  return `In ${diff} day${diff === 1 ? "" : "s"}`;
}

export function Calendar() {
  const { data: me } = useGetMe();
  const { data: deadlines, isLoading } = useGetComplianceCalendar(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetComplianceCalendarQueryKey({ clientPartyId: me?.clientPartyId || "" }),
      },
    },
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compliance Calendar</h1>
        <p className="text-muted-foreground">
          Filing deadlines and penalty watch, computed from your invoice book.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : !deadlines || deadlines.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CalendarClock className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">Nothing due right now</p>
            <p className="text-sm text-muted-foreground">
              You're all caught up on filings.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {deadlines.map((d) => (
            <Card
              key={d.id}
              className={d.status === "overdue" ? "border-destructive/40" : ""}
            >
              <CardContent className="flex items-start justify-between gap-3 p-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="mt-0.5">
                    {d.status === "overdue" ? (
                      <AlertTriangle className="w-5 h-5 text-destructive" />
                    ) : (
                      <CalendarClock className="w-5 h-5 text-muted-foreground" />
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
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${SEVERITY[d.severity] || SEVERITY.info}`}
                      >
                        {daysAway(d.dueDate)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Due {formatDate(d.dueDate)}
                      </span>
                    </div>
                  </div>
                </div>
                {d.invoiceId && (
                  <Link
                    href={`/invoices/${d.invoiceId}`}
                    className="text-primary text-sm inline-flex items-center shrink-0 hover:underline"
                  >
                    Open <ChevronRight className="w-4 h-4" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
