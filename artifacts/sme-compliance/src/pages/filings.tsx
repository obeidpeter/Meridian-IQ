import { useState } from "react";
import {
  useListFilings,
  getListFilingsQueryKey,
} from "@workspace/api-client-react";
import type { Filing, ListFilingsParams } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CapabilityGate } from "@/components/capability-gate";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillToggle } from "@/components/pill-toggle";
import { QueryError } from "@/components/query-error";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDate, pillClasses } from "@/lib/format";
import {
  FILING_KIND_LABELS,
  FILING_STATUS_LABELS,
  filingKindLabel,
  filingPeriodLabel,
  filingStatusLabel,
  taxTypeLabel,
} from "@workspace/format/filing-copy";
import {
  OBLIGATION_DUE_SOON_DAYS,
  deadlineDaysUntil,
  localDayIso,
} from "@workspace/format/notice-copy";
import { CalendarCheck2 } from "lucide-react";

// Read-only by design: the filings register is minted and walked by the firm
// (sync, then upcoming → prepared → filed on the console's Filing Desk) —
// this page only watches the record: which returns the period owes, what is
// already filed, and the due dates. The server pins a client_user to its own
// party (no clientPartyId is sent). The platform records the filing; it
// never files anything itself.

// ---- Display vocabulary (exported for tests) -------------------------------
// The words come from @workspace/format/filing-copy — the one home for the
// filing status/kind/period vocabulary shared with the console (and later
// mobile). Only the pill CLASSES stay per-app (tones are this app's design
// language).

export {
  FILING_KIND_LABELS,
  FILING_STATUS_LABELS,
  filingKindLabel,
  filingPeriodLabel,
  filingStatusLabel,
  taxTypeLabel,
};

export const DUE_SOON_WINDOW_DAYS = OBLIGATION_DUE_SOON_DAYS;

export function filingBadgeClasses(status: string): string {
  switch (status) {
    case "upcoming":
      return pillClasses("slate");
    case "prepared":
      return pillClasses("blue");
    case "filed":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

/**
 * Deadline urgency for the row's visual flag — display logic only, computed
 * client-side: overdue = due date before today, due-soon = due today or
 * within the next 7 days. Takes todayIso explicitly so it is a pure function
 * of its inputs; the page applies it only to UNFILED rows (a filed return is
 * in and never reads as overdue). Null for far-off deadlines or unparseable
 * dates (the shared day-math returns NaN).
 */
export function deadlineFlag(
  dueDate: string,
  todayIso: string,
): "overdue" | "due-soon" | null {
  const days = deadlineDaysUntil(todayIso, dueDate);
  if (Number.isNaN(days)) return null;
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_WINDOW_DAYS) return "due-soon";
  return null;
}

// ---- Page ------------------------------------------------------------------

const FILTERS = [
  { key: "upcoming", label: "Upcoming" },
  { key: "prepared", label: "Prepared" },
  { key: "filed", label: "Filed" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function FilingRow({
  filing,
  todayIso,
}: {
  filing: Filing;
  todayIso: string;
}) {
  // Only an unfiled return escalates on its due date.
  const flag =
    filing.status === "filed" ? null : deadlineFlag(filing.dueDate, todayIso);
  const detailParts = [
    filingPeriodLabel(filing.period),
    filing.filedReference ? `Ref ${filing.filedReference}` : null,
  ].filter(Boolean);

  return (
    <Card data-testid={`row-filing-${filing.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">
                {filingKindLabel(filing.taxType)}
              </span>
              <span
                className={filingBadgeClasses(filing.status)}
                data-testid={`badge-status-${filing.id}`}
              >
                {filingStatusLabel(filing.status)}
              </span>
              {flag && (
                <span
                  className={pillClasses(flag === "overdue" ? "red" : "amber")}
                  data-testid={`flag-deadline-${filing.id}`}
                >
                  {flag === "overdue" ? "Overdue" : "Due soon"}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {detailParts.join(" · ")}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p
              className={`text-sm ${
                flag === "overdue"
                  ? "text-destructive font-medium"
                  : flag === "due-soon"
                    ? "text-amber-700 dark:text-amber-400 font-medium"
                    : "text-muted-foreground"
              }`}
              data-testid={`text-due-${filing.id}`}
            >
              {filing.status === "filed" && filing.filedDate
                ? `Filed ${formatDate(filing.filedDate)}`
                : `Due ${formatDate(filing.dueDate)}`}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FilingsContent() {
  const [filter, setFilter] = useState<FilterKey>("upcoming");
  const todayIso = localDayIso(new Date());

  // The server pins a client_user to its own party — no clientPartyId is
  // sent.
  const params: ListFilingsParams =
    filter === "all" ? {} : { status: filter };
  const { data, isLoading, isError, refetch } = useListFilings(params, {
    query: { queryKey: getListFilingsQueryKey(params) },
  });
  const filings = data?.filings ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Filings"
        description="The VAT returns, PAYE remittances and WHT remittances your firm tracks for each period, with their filing deadlines. Your accountant records each one as it is prepared and filed — the platform never files anything itself."
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <PillToggle
            key={f.key}
            active={filter === f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-filings-${f.key}`}
          >
            {f.label}
          </PillToggle>
        ))}
      </div>

      {isLoading ? (
        <SkeletonList count={5} itemClassName="h-20" />
      ) : isError ? (
        <QueryError thing="your filings" onRetry={() => refetch()} />
      ) : filings.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarCheck2}
            title={
              filter === "all" ? "No filings tracked" : `No ${filter} filings`
            }
            description={
              filter === "all"
                ? "When your accountant syncs the period's register, its VAT return and PAYE remittance appear here with their due dates."
                : "Nothing with this status right now."
            }
          >
            {filter !== "all" && (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => setFilter("all")}
                data-testid="button-show-all-filings"
              >
                Show all filings
              </Button>
            )}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {filings.map((filing) => (
            <FilingRow key={filing.id} filing={filing} todayIso={todayIso} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Filings() {
  usePageTitle("Filings");
  return (
    <CapabilityGate capability="filing.read">
      <FilingsContent />
    </CapabilityGate>
  );
}
