import { useState } from "react";
import {
  useGetMe,
  useCreatePlanRun,
  useGetMonthEndClose,
  getGetMonthEndCloseQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errorStatus } from "@workspace/api-errors";
import { PlanRunProgress } from "../clerk-ask";
import { AlertTriangle, CheckCircle, CalendarCheck } from "lucide-react";
import { summaryPillClasses } from "@/lib/format";
import { closeAttentionCount, visibleCloseItems } from "@/lib/close-items";
import { MonthlyAutomationStrip } from "./monthly-automation-strip";

// Month-end close (round 19): the platform's deterministic advisories
// composed into one checklist — each line computed by the same check that
// powers its own card, so the two can never disagree. Advisory only; a
// human closes the month.
export function MonthEndCloseCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  // PL-02 gate: "Run with Clerk" and the monthly-automation strip are Clerk
  // surfaces — absent while the clerk_ai feature is dark, exactly like the
  // nav links and dock (layout.tsx). The deterministic checklist itself
  // stays: it spends no tokens and works at launch.
  const { data: me } = useGetMe();
  const clerkLit = !!me?.features.includes("clerk_ai");
  const { data: close, isSuccess } = useGetMonthEndClose(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetMonthEndCloseQueryKey({ clientPartyId }),
        // The checklist composes seven detector queries server-side —
        // don't re-run the sweep on every dashboard focus.
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  // Run with Clerk (rounds 32/34): the checklist made executable — one
  // approval queues the month_end_close template (draft missing recurring
  // invoices → submit overdue → retry failed), assembled server-side for
  // THIS client and executed by the worker with per-step re-validation.
  // Any drafts the run raises stay DRAFTS behind the machine-draft
  // submission wall until a human reviews and renumbers them. A 409 means
  // nothing is currently eligible — an honest no-op, not an error.
  const { toast } = useToast();
  const createRun = useCreatePlanRun();
  const [runId, setRunId] = useState<string | null>(null);
  if (!isSuccess || !close) return null;
  // Lanes for desks this account cannot reach are dropped, and the header
  // count is re-derived so the pill never disagrees with the list below.
  const items = visibleCloseItems(close.items, me?.features ?? []);
  const attentionCount = closeAttentionCount(items);
  return (
    <Card data-testid="month-end-close">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span
            className="mi-card-icon"
            data-tone={attentionCount > 0 ? "warning" : "positive"}
          >
            <CalendarCheck aria-hidden="true" />
          </span>
          Month-end close
          {attentionCount > 0 ? (
            <span
              className={`ml-auto ${summaryPillClasses("amber")}`}
              data-testid="text-close-attention-count"
            >
              {attentionCount} to review
            </span>
          ) : (
            <span
              className={`ml-auto ${summaryPillClasses("emerald")}`}
              data-testid="text-close-all-clear"
            >
              All clear
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex items-start gap-2.5 text-sm"
              data-testid={`close-item-${item.key}`}
            >
              {item.status === "attention" ? (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p
                  className={
                    item.status === "attention"
                      ? "font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {item.label}
                  {item.count > 0 && (
                    <span className="ml-1.5 tabular-nums">({item.count})</span>
                  )}
                </p>
                {item.status === "attention" && (
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
        {clerkLit &&
          (runId ? (
            <PlanRunProgress runId={runId} />
          ) : (
            close.attentionCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={createRun.isPending}
                data-testid="button-run-month-end"
                onClick={() =>
                  createRun.mutate(
                    {
                      data: { templateKey: "month_end_close", clientPartyId },
                    },
                    {
                      onSuccess: (run) => setRunId(run.id),
                      onError: (e) =>
                        // 409 = the honest empty (NOTHING_TO_RUN); anything
                        // else is a real failure and must not read as one.
                        toast(
                          errorStatus(e) === 409
                            ? {
                                title: "Nothing to run right now",
                                description:
                                  "No invoices are currently eligible for the close actions — the remaining checklist items need hands-on attention.",
                              }
                            : {
                                title: "Couldn't start the close run",
                                description:
                                  "Nothing was changed. Try again shortly.",
                              },
                        ),
                    },
                  )
                }
              >
                {createRun.isPending ? "Starting…" : "Run with Clerk"}
              </Button>
            )
          ))}
        {clerkLit && <MonthlyAutomationStrip clientPartyId={clientPartyId} />}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {close.note}
        </p>
      </CardContent>
    </Card>
  );
}
