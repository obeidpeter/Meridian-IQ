import { Link } from "wouter";
import {
  useGetMe,
  useGetComplianceCalendar,
  getGetComplianceCalendarQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  CalendarClock,
  AlertTriangle,
  ChevronRight,
  Receipt,
} from "lucide-react";
import {
  formatLagosDate,
  humanize,
  lagosDayDiff,
  pillClasses,
  severityBadgeClasses,
} from "@/lib/format";

// The badge names the state in words — color alone is invisible to
// color-blind users — and pairs it with a countdown in LAGOS calendar days
// (statutory deadlines are Lagos-midnight instants; see lagosDayDiff).
// Off-contract statuses from a newer server humanize instead of vanishing.
// Exported for the unit tests.
export function deadlineBadgeText(status: string, diff: number | null): string {
  if (status === "met") return "Done";
  if (status === "overdue") {
    return diff !== null && diff < 0
      ? `Overdue · ${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"}`
      : "Overdue";
  }
  const rel =
    diff === null
      ? null
      : diff < 0
        ? `${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} overdue`
        : diff === 0
          ? "today"
          : `in ${diff} day${diff === 1 ? "" : "s"}`;
  const word =
    status === "due_soon"
      ? "Due soon"
      : status === "upcoming"
        ? "On track"
        : humanize(status);
  return rel ? `${word} · ${rel}` : word;
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
  const features = new Set(me?.features ?? []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance calendar"
        description="Filing deadlines and penalty watch, computed from your invoice book. Deadlines run on the Lagos (WAT) statutory calendar."
      />

      <RequireClientScope thing="compliance calendar">
        {isLoading ? (
          <SkeletonList count={5} itemClassName="h-20" />
        ) : isError ? (
          <QueryError
            thing="your compliance calendar"
            onRetry={() => refetch()}
          />
        ) : !deadlines || deadlines.length === 0 ? (
          <Card>
            <EmptyState
              icon={CalendarClock}
              title="Nothing due right now"
              description="You're all caught up on filings. New deadlines appear here as invoices are stamped and reporting windows open."
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {deadlines.map((d) => {
              const diff = lagosDayDiff(d.dueDate);
              return (
                <Card
                  key={d.id}
                  className={
                    d.status === "overdue" ? "border-destructive/40" : ""
                  }
                >
                  <CardContent className="flex items-start justify-between gap-3 p-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="mt-0.5">
                        {/* Kind picks the glyph only — overdue always wins, and
                          kinds without a mapping (including ones newer than
                          this build) fall through to the calendar glyph. */}
                        {d.status === "overdue" ? (
                          <AlertTriangle
                            className="w-5 h-5 text-destructive"
                            aria-hidden="true"
                          />
                        ) : d.kind === "bill_due" ? (
                          <Receipt
                            className="w-5 h-5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : (
                          <CalendarClock
                            className="w-5 h-5 text-muted-foreground"
                            aria-hidden="true"
                          />
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
                            className={
                              d.status === "met"
                                ? pillClasses("emerald")
                                : severityBadgeClasses(d.severity)
                            }
                          >
                            {deadlineBadgeText(d.status, diff)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            Due {formatLagosDate(d.dueDate)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {/* A bill_due deadline's invoice is a supplier bill, which
                      lives on the /bills surface — the invoice vault's detail
                      route can't show it for client users. Statutory rows
                      carry no invoiceId, so they deep-link by KIND instead:
                      /vat is always lit; /b2c only when its feature is
                      (PL-02 — never navigate into a dark page). */}
                    {d.invoiceId ? (
                      <Link
                        href={
                          d.kind === "bill_due"
                            ? "/bills"
                            : `/invoices/${d.invoiceId}`
                        }
                        className="text-primary text-sm inline-flex items-center shrink-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                      >
                        Open{" "}
                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                      </Link>
                    ) : d.kind === "vat_return" ? (
                      <Link
                        href="/vat"
                        className="text-primary text-sm inline-flex items-center shrink-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                        data-testid="link-calendar-vat"
                      >
                        Review VAT position{" "}
                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                      </Link>
                    ) : d.kind === "b2c_report" &&
                      features.has("b2c_reporting") ? (
                      <Link
                        href="/b2c"
                        className="text-primary text-sm inline-flex items-center shrink-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                        data-testid="link-calendar-b2c"
                      >
                        Open B2C reports{" "}
                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                      </Link>
                    ) : null}
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
