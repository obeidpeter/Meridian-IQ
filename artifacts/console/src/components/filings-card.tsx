import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListFilings,
  useSyncFilings,
  useUpdateFilingStatus,
  getListFilingsQueryKey,
} from "@workspace/api-client-react";
import type { Filing } from "@workspace/api-client-react";
import {
  filingKindLabel,
  filingPeriodLabel,
  filingStatusLabel,
} from "@workspace/format/filing-copy";
import { localDayIso } from "@workspace/format/notice-copy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { formatDate, pillClasses, type BadgeTone } from "@/lib/format";
import { CalendarCheck2, RefreshCw } from "lucide-react";

// Statutory filings for one client (Filing Desk): the register's other half —
// where the obligations card tracks the AUTHORITY's notices, this card tracks
// the CALENDAR's returns (the VAT return and PAYE remittance each period
// owes). "Sync register" asks the server to mint the current period's rows
// (idempotent — a second sync mints nothing), and each row then walks
// upcoming → prepared → filed via the per-row actions, with "Mark filed"
// capturing the filed date and the authority's receipt reference as evidence.
// The platform records the filing; it never files anything itself — the
// payables payStatus posture.
//
// Actions gate on the filing.write capability (firm staff; the server
// enforces it regardless — the clerk-actions-card mirror), so a read-only
// viewer (auditor) sees the register and its pills but no buttons that could
// only ever 403.

// ---- Pure helpers (unit-tested directly) -----------------------------------

/**
 * Overdue = not yet FILED past its statutory due date. A filed row is never
 * painted overdue — the return is in, whatever the calendar says. Prepared
 * still counts: preparation is firm work, filing is what the deadline wants.
 */
export function filingOverdue(
  f: Pick<Filing, "status" | "dueDate">,
  today: string,
): boolean {
  return f.status !== "filed" && f.dueDate < today;
}

/**
 * The status pill's words and tone. The WORDS come from the shared
 * filing-copy vocabulary (upcoming → "Upcoming", filed → "Filed" — the same
 * words the SME app uses), with "Overdue" overriding for an unfiled row past
 * its due date. The TONES are deliberately console-local: slate an upcoming
 * row (nothing started), blue prepared as intermediate (the console's
 * non-terminal colour, cf. responded:blue in the obligations card), emerald
 * filed, red overdue.
 */
export function filingPill(
  f: Pick<Filing, "status">,
  overdue: boolean,
): { tone: BadgeTone; label: string } {
  if (overdue) return { tone: "red", label: "Overdue" };
  const tone: BadgeTone =
    f.status === "filed"
      ? "emerald"
      : f.status === "prepared"
        ? "blue"
        : "slate";
  return { tone, label: filingStatusLabel(f.status) };
}

// ---- The card ---------------------------------------------------------------

export function FilingsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = { clientPartyId };
  const { data, isLoading, error, refetch } = useListFilings(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListFilingsQueryKey(params),
      staleTime: 60_000,
      retry: false,
    },
  });

  // getListFilingsQueryKey() prefix-matches every filtered variant of the
  // list (this client's, the SME app's twin), so all go stale together after
  // any write.
  const invalidateFilings = () =>
    queryClient.invalidateQueries({ queryKey: getListFilingsQueryKey() });

  // Sync and the status walks assertCan filing.write server-side (firm
  // staff). Mirror that here so a read-only viewer sees no dead buttons.
  const { data: me } = useGetMe();
  const canWrite = !!me?.capabilities.includes("filing.write");

  // "Mark filed" panel: which row is expanded (one at a time) and its
  // evidence draft — the filed date defaults to today, the reference is the
  // authority's receipt number, optional.
  const [filedPanelId, setFiledPanelId] = useState<string | null>(null);
  const [filedDate, setFiledDate] = useState("");
  const [filedReference, setFiledReference] = useState("");

  const toggleFiledPanel = (id: string) => {
    setFiledPanelId((cur) => (cur === id ? null : id));
    // Fresh evidence draft either way; the comparison floor and the input
    // default share the localDayIso kernel (BROWSER-local by design — a
    // form default, not a statutory clock).
    setFiledDate(localDayIso(new Date()));
    setFiledReference("");
  };

  const sync = useSyncFilings({
    mutation: {
      onSuccess: (result) => {
        invalidateFilings();
        toast({
          title: "Register synced",
          description:
            result.minted > 0
              ? `${result.minted} return${result.minted === 1 ? "" : "s"} added for the current period.`
              : "Already up to date — nothing new to mint.",
        });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not sync the register",
          fallback: "Try again.",
        }),
    },
  });

  const updateStatus = useUpdateFilingStatus({
    mutation: {
      onSuccess: (filing) => {
        invalidateFilings();
        setFiledPanelId(null);
        toast({
          title: filing.status === "filed" ? "Marked filed" : "Marked prepared",
        });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not update the filing",
          fallback: "Try again.",
        }),
    },
  });

  const rows = data?.filings ?? [];
  const today = localDayIso(new Date());

  return (
    <Card data-testid="card-filings">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarCheck2 className="w-5 h-5" aria-hidden="true" /> Filings
          register
        </CardTitle>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            data-testid="button-sync-filings"
          >
            <RefreshCw
              className={`w-4 h-4 mr-1 ${sync.isPending ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {sync.isPending ? "Syncing…" : "Sync register"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-24 w-full" data-testid="skeleton-filings" />
        ) : error ? (
          <QueryError
            thing="the filings register"
            onRetry={() => refetch()}
            detail={error instanceof Error ? error.message : undefined}
          />
        ) : rows.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-filings-empty"
          >
            No filings tracked for this client yet. Sync the register to mint
            the current period's VAT return and PAYE remittance rows.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((f) => {
              const overdue = filingOverdue(f, today);
              const pill = filingPill(f, overdue);
              return (
                <div
                  key={f.id}
                  className={`border rounded-md p-3 ${
                    overdue
                      ? "border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20"
                      : ""
                  }`}
                  data-testid={`row-filing-${f.id}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-medium text-sm">
                      {filingKindLabel(f.taxType)} ·{" "}
                      {filingPeriodLabel(f.period)}
                    </p>
                    <span
                      className={pillClasses(pill.tone)}
                      data-testid={`pill-filing-${f.id}`}
                    >
                      {pill.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Due {formatDate(f.dueDate)}
                    {f.filedDate ? ` · Filed ${formatDate(f.filedDate)}` : ""}
                    {f.filedReference ? ` · Ref ${f.filedReference}` : ""}
                  </p>
                  {canWrite && f.status !== "filed" && (
                    <div className="flex gap-2 mt-2">
                      {f.status === "upcoming" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateStatus.mutate({
                              id: f.id,
                              data: { status: "prepared" },
                            })
                          }
                          disabled={updateStatus.isPending}
                          data-testid={`button-filing-prepared-${f.id}`}
                        >
                          Mark prepared
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={
                          filedPanelId === f.id ? "secondary" : "outline"
                        }
                        onClick={() => toggleFiledPanel(f.id)}
                        data-testid={`button-filing-filed-${f.id}`}
                      >
                        Mark filed
                      </Button>
                    </div>
                  )}
                  {canWrite && f.status !== "filed" && filedPanelId === f.id && (
                    <div
                      className="mt-2 rounded-md border p-3 space-y-3"
                      data-testid={`panel-filing-filed-${f.id}`}
                    >
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor={`filing-filed-date-${f.id}`}>
                            Filed date
                          </Label>
                          <Input
                            id={`filing-filed-date-${f.id}`}
                            type="date"
                            value={filedDate}
                            onChange={(e) => setFiledDate(e.target.value)}
                            data-testid={`input-filing-filed-date-${f.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`filing-reference-${f.id}`}>
                            Filing reference (optional)
                          </Label>
                          <Input
                            id={`filing-reference-${f.id}`}
                            value={filedReference}
                            onChange={(e) => setFiledReference(e.target.value)}
                            data-testid={`input-filing-reference-${f.id}`}
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() =>
                          // The contract requires filedDate for "filed"; the
                          // optional reference is trimmed and OMITTED when
                          // empty (absent-or-valued, never "").
                          updateStatus.mutate({
                            id: f.id,
                            data: {
                              status: "filed",
                              filedDate,
                              ...(filedReference.trim()
                                ? { filedReference: filedReference.trim() }
                                : {}),
                            },
                          })
                        }
                        disabled={!filedDate || updateStatus.isPending}
                        data-testid={`button-filing-filed-confirm-${f.id}`}
                      >
                        {updateStatus.isPending ? "Recording…" : "Confirm filed"}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Evidence only — the register records that the firm prepared and filed
          each return; the platform never files anything itself.
        </p>
      </CardContent>
    </Card>
  );
}
