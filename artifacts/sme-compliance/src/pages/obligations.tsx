import { useState } from "react";
import {
  useListObligations,
  getListObligationsQueryKey,
} from "@workspace/api-client-react";
import type {
  ListObligationsParams,
  Obligation,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CapabilityGate } from "@/components/capability-gate";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillToggle } from "@/components/pill-toggle";
import { QueryError } from "@/components/query-error";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatAmount, formatDate, pillClasses } from "@/lib/format";
import {
  AUTHORITY_LABELS,
  NOTICE_TYPE_LABELS,
  OBLIGATION_DUE_SOON_DAYS,
  authorityLabel,
  deadlineDaysUntil,
  localDayIso,
  noticeTypeLabel,
  obligationStatusLabel,
} from "@workspace/format/notice-copy";
import { Scale } from "lucide-react";

// Read-only by design: obligations are recorded when the firm approves a
// captured tax-authority notice, and their status is firm work — this page
// only watches the record and its response deadlines. The server pins a
// client_user to its own party (no clientPartyId is sent) and orders the
// list soonest deadline first, so there is no client-side sort.

// ---- Display vocabulary (exported for tests) -------------------------------
// The words come from @workspace/format/notice-copy — the one home for the
// notice/authority/status vocabulary shared with the console and mobile.
// Only the pill CLASSES stay per-app (tones are this app's design language).

export {
  AUTHORITY_LABELS,
  NOTICE_TYPE_LABELS,
  authorityLabel,
  noticeTypeLabel,
  obligationStatusLabel,
};

export const DUE_SOON_WINDOW_DAYS = OBLIGATION_DUE_SOON_DAYS;

export function obligationBadgeClasses(status: string): string {
  switch (status) {
    case "open":
      return pillClasses("amber");
    case "responded":
      return pillClasses("emerald");
    case "closed":
      return pillClasses("slate");
    default:
      return pillClasses("slate");
  }
}

/**
 * Deadline urgency for the row's visual flag — display logic only, computed
 * client-side: overdue = due date before today, due-soon = due today or
 * within the next 7 days. Takes todayIso explicitly so it is a pure function
 * of its inputs; the page applies it only to OPEN obligations (a responded
 * or closed one has been dealt with and never reads as overdue). Null for
 * far-off deadlines or unparseable dates (the shared day-math returns NaN).
 */
export function deadlineFlag(
  responseDueDate: string,
  todayIso: string,
): "overdue" | "due-soon" | null {
  const days = deadlineDaysUntil(todayIso, responseDueDate);
  if (Number.isNaN(days)) return null;
  if (days < 0) return "overdue";
  if (days <= OBLIGATION_DUE_SOON_DAYS) return "due-soon";
  return null;
}

// ---- Page ------------------------------------------------------------------

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "responded", label: "Responded" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function ObligationRow({
  obligation,
  todayIso,
}: {
  obligation: Obligation;
  todayIso: string;
}) {
  // Only an open obligation escalates on its deadline.
  const flag =
    obligation.status === "open"
      ? deadlineFlag(obligation.responseDueDate, todayIso)
      : null;
  const detailParts = [
    authorityLabel(obligation.authority),
    obligation.reference ? `Ref ${obligation.reference}` : null,
    obligation.period || null,
  ].filter(Boolean);

  return (
    <Card data-testid={`row-obligation-${obligation.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">
                {noticeTypeLabel(obligation.noticeType)}
              </span>
              <span
                className={obligationBadgeClasses(obligation.status)}
                data-testid={`badge-status-${obligation.id}`}
              >
                {obligationStatusLabel(obligation.status)}
              </span>
              {flag && (
                <span
                  className={pillClasses(flag === "overdue" ? "red" : "amber")}
                  data-testid={`flag-deadline-${obligation.id}`}
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
            {obligation.amount && (
              <p className="font-semibold tabular-nums">
                {formatAmount(obligation.amount, obligation.currency ?? "NGN")}
              </p>
            )}
            <p
              className={`text-sm ${
                flag === "overdue"
                  ? "text-destructive font-medium"
                  : flag === "due-soon"
                    ? "text-amber-700 dark:text-amber-400 font-medium"
                    : "text-muted-foreground"
              }`}
              data-testid={`text-due-${obligation.id}`}
            >
              Respond by {formatDate(obligation.responseDueDate)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ObligationsContent() {
  const [filter, setFilter] = useState<FilterKey>("open");
  const todayIso = localDayIso(new Date());

  // The server pins a client_user to its own party — no clientPartyId — and
  // returns the list soonest response deadline first.
  const params: ListObligationsParams =
    filter === "all" ? {} : { status: filter };
  const { data, isLoading, isError, refetch } = useListObligations(params, {
    query: { queryKey: getListObligationsQueryKey(params) },
  });
  const obligations = data?.obligations ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Obligations"
        description="Tax-authority notices your firm has recorded, with their response deadlines. Your accountant updates each one as it is responded to and closed."
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <PillToggle
            key={f.key}
            active={filter === f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-obligations-${f.key}`}
          >
            {f.label}
          </PillToggle>
        ))}
      </div>

      {isLoading ? (
        <SkeletonList count={5} itemClassName="h-20" />
      ) : isError ? (
        <QueryError thing="your obligations" onRetry={() => refetch()} />
      ) : obligations.length === 0 ? (
        <Card>
          <EmptyState
            icon={Scale}
            title={
              filter === "all"
                ? "No obligations recorded"
                : `No ${filter} obligations`
            }
            description={
              filter === "all"
                ? "When your accountant approves a captured tax-authority notice, it appears here with its response deadline."
                : "Nothing with this status right now."
            }
          >
            {filter !== "all" && (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => setFilter("all")}
                data-testid="button-show-all-obligations"
              >
                Show all obligations
              </Button>
            )}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {obligations.map((obligation) => (
            <ObligationRow
              key={obligation.id}
              obligation={obligation}
              todayIso={todayIso}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Obligations() {
  usePageTitle("Obligations");
  return (
    <CapabilityGate capability="obligation.read">
      <ObligationsContent />
    </CapabilityGate>
  );
}
