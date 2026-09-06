import { useState, type ReactNode } from "react";
import {
  useGetClerkMetrics,
  getGetClerkMetricsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkMetrics,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryError } from "@/components/query-error";
import { ClerkPageHeader } from "@/components/clerk-shell";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  formatPct,
} from "@/lib/format";
import {
  HEALTH_TABS,
  HEALTH_WINDOWS,
  qualityAlertText,
} from "./format";
import { OverviewTab } from "./overview-tab";
import { QualityTab } from "./quality-tab";
import { EconomicsTab } from "./economics-tab";
import { EvalsTab } from "./evals-tab";
import { ModelCanaryCard, PromptCanaryCard } from "./canary-cards";


// ---- Health tab -----------------------------------------------------------
// Read-only operational metrics for the Clerk: case flow, ask refusals and
// inference quality per model+prompt cohort. Numbers come straight from
// /clerk/metrics; the window selector re-queries the server.

// R110 split the 2,963-line page into this shell, one module per tab, the
// card modules and the pure helpers; the route (App.tsx) and the unit suite
// keep importing "@/pages/clerk-health" / "./clerk-health".

// The unit suite (clerk-health.test.ts) and the tab list pin these through
// this module, so the split keeps the page's import path as its surface.
export {
  HEALTH_WINDOWS,
  HEALTH_TABS,
  OUTCOME_TONE,
  EVAL_RISK_TONE,
  EVAL_OUTCOME_TONE,
  fmtEvalDuration,
  fmtMs,
  fmtTokens,
  fmtUsd,
  casesTileDetail,
  overrideRateClass,
  shapeExample,
  modelCanaryRowClass,
  qualityAlertText,
  retrievalRunLine,
  retrievalMissLine,
  retrievalTrendLine,
  canaryPrefillNote,
  FIXTURE_SOURCE_TONE,
  fixtureSourceLabel,
  fixtureAccuracy,
  retireDisabledReason,
  corpusSummary,
  mintFixtureErrorCopy,
  askFeedbackTotalsLine,
  CORPUS_PREVIEW_ROWS,
  visibleFixtureCount,
} from "./format";

export function ClerkHealthPage() {
  usePageTitle("Clerk health");
  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Operations"
        title="Health"
        description="Volume, accuracy, latency and cost for every Clerk surface — and the watchdog that trips the kill switch."
      />
      <HealthPanel />
    </div>
  );
}


export function HealthPanel() {
  const [windowDays, setWindowDays] = useState(30);
  const params = { windowDays };
  const {
    data: metrics,
    isLoading,
    error,
    refetch,
  } = useGetClerkMetrics(params, {
    query: { queryKey: getGetClerkMetricsQueryKey(params) },
  });

  // The metrics-driven tabs share one guard: skeleton while /clerk/metrics
  // loads, the query error (with its HTTP status) on failure, content once it
  // resolves. It repeats per tab because each tab owns its own subtree; the
  // callback parameter shadows `metrics` with the non-null value so the
  // section markup inside stays exactly as it was when stacked.
  const withMetrics = (
    render: (metrics: ClerkMetrics) => ReactNode,
  ): ReactNode =>
    isLoading ? (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    ) : error || !metrics ? (
      <QueryError
        thing="Clerk health metrics"
        onRetry={() => refetch()}
        // The fetch error message carries the HTTP status ("HTTP 404 …"),
        // which instantly separates a stale api-server build (404 — rebuild
        // and restart the server) from a server fault (500).
        detail={error instanceof Error ? error.message : undefined}
      />
    ) : (
      render(metrics)
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          How the Clerk is behaving — case flow, refusals and inference quality.
        </p>
        <div className="w-36">
          <Select
            value={String(windowDays)}
            onValueChange={(v) => setWindowDays(Number(v))}
          >
            <SelectTrigger
              aria-label="Metrics window"
              data-testid="select-health-window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HEALTH_WINDOWS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  Last {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Health-critical alerts are hoisted above the tabs so a
          resistance or kept-rate drop stays visible no matter which tab
          is active. Red stays reserved for guardrail alerts (the
          resistance drop); the kept-rate banner keeps its AMBER — a
          quality signal that deserves a watchful eye, matching the amber
          band of overrideRateClass. */}
      {metrics?.resistanceAlert && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          data-testid="alert-resistance-drop"
        >
          <p className="font-semibold">
            Injection resistance dropped:{" "}
            {formatPct(metrics.resistanceAlert.fromRate)} in{" "}
            {metrics.resistanceAlert.fromMonth} →{" "}
            {formatPct(metrics.resistanceAlert.toRate)} in{" "}
            {metrics.resistanceAlert.toMonth} (
            {metrics.resistanceAlert.injectionFixtures} injection fixtures).
          </p>
          <p className="mt-1 text-xs">
            Review recent prompt changes and the red-team fixtures before
            promoting anything. The sweep has recorded this drop in the audit
            ledger.
          </p>
        </div>
      )}
      {metrics?.qualityAlert && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="alert-quality-drop"
        >
          <p className="font-semibold">
            {qualityAlertText(metrics.qualityAlert)}
          </p>
          <p className="mt-1 text-xs">
            Check the field-corrections and correction-shapes tables for where
            the overrides land before changing prompts or models.
          </p>
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap" data-testid="tabs-health">
          {HEALTH_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              data-testid={`tab-health-${t.value}`}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Every tab stays force-mounted (the advisory page's idiom) so
            section state — a run canary's report, the corpus "show all"
            toggle, the eval fixture detail — survives switching tabs,
            exactly as it did when the sections were stacked. */}
        <TabsContent
          value="overview"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <OverviewTab withMetrics={withMetrics} />
        </TabsContent>

        <TabsContent
          value="quality"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <QualityTab withMetrics={withMetrics} />
        </TabsContent>

        <TabsContent
          value="economics"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <EconomicsTab withMetrics={withMetrics} />
        </TabsContent>

        <TabsContent
          value="evals"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <EvalsTab metrics={metrics} />
        </TabsContent>

        <TabsContent
          value="canaries"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <PromptCanaryCard />
          <ModelCanaryCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
