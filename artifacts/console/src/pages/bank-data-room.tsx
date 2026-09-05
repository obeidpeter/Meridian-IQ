import { useState } from "react";
import {
  getGetBankDataRoomQueryKey,
  getListBankDataRoomAccessQueryKey,
  useGetBankDataRoom,
  useListBankDataRoomAccess,
} from "@workspace/api-client-react";
import { Metric, MetricStrip, WorkspaceHeader } from "@workspace/web-ui";
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  EyeOff,
  Fingerprint,
  Landmark,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { pillClasses } from "@/lib/format";

const amountBand: Record<string, string> = {
  unavailable: "Amount unavailable",
  under_250k: "Below ₦250k",
  "250k_to_1m": "₦250k–₦1m",
  "1m_to_5m": "₦1m–₦5m",
  "5m_to_20m": "₦5m–₦20m",
  "20m_plus": "₦20m+",
};

const percent = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "Suppressed"
    : `${Math.round(value * 100)}%`;

const dateTime = (value: string | null | undefined): string =>
  value
    ? new Intl.DateTimeFormat("en-NG", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not yet available";

function LoadingState() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading bank Data Room">
      <div className="grid gap-px overflow-hidden rounded-lg border bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-none bg-white" />
        ))}
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function CoverageRow({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const numeric = value ?? 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="font-bold text-slate-800">{label}</span>
        <span className="tabular-nums text-slate-600">{percent(value)}</span>
      </div>
      <Progress
        value={numeric * 100}
        className="h-2"
        aria-label={`${label}: ${percent(value)}`}
      />
    </div>
  );
}

export function BankDataRoom() {
  usePageTitle("Bank Data Room");
  const [activeTab, setActiveTab] = useState("cohorts");
  const room = useGetBankDataRoom({
    query: { queryKey: getGetBankDataRoomQueryKey(), staleTime: 60_000 },
  });
  const access = useListBankDataRoomAccess(
    { limit: 50 },
    {
      query: {
        queryKey: getListBankDataRoomAccessQueryKey({ limit: 50 }),
        staleTime: 60_000,
        enabled: activeTab === "access",
      },
    },
  );

  const refresh = () => {
    void room.refetch();
    if (activeTab === "access") void access.refetch();
  };

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Private institutional workspace"
        title="Credit Data Room"
        description="Consent-governed, anonymized portfolio evidence for diligence. No customer identities, exact amounts, offers or financing actions are exposed here."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={room.isFetching || access.isFetching}
          >
            <RefreshCw
              className={`size-4 ${room.isFetching || access.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh evidence
          </Button>
        }
      />

      <section className="grid gap-4 border-y border-emerald-900/20 bg-[#073c36] px-5 py-5 text-white sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <span className="grid size-11 place-items-center rounded-md bg-[#d5b84b] text-[#082f31]">
          <LockKeyhole className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-sm font-extrabold">Privacy boundary enforced</h2>
          <p className="mt-1 text-xs leading-5 text-white/70">
            Fixed quarterly cohorts, minimum population thresholds and amount
            bands prevent drill-down to a business or invoice. Every view is
            recorded against your bank access grant.
          </p>
        </div>
        <span className="text-xs font-bold text-[#f0d978]">Aggregate only</span>
      </section>

      {room.isLoading ? (
        <LoadingState />
      ) : room.isError || !room.data ? (
        <QueryError
          thing="the credit Data Room"
          onRetry={() => room.refetch()}
        />
      ) : !room.data.available || !room.data.metrics ? (
        <section className="border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <EyeOff
            className="mx-auto size-8 text-slate-400"
            aria-hidden="true"
          />
          <h2 className="mt-4 text-lg font-extrabold text-slate-950">
            Cohort withheld for privacy
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
            The consented population has not reached the minimum cohort of{" "}
            {room.data.privacy.minimumCohortSize} businesses. No counts or
            derived rates are released below that boundary.
          </p>
        </section>
      ) : (
        <>
          <MetricStrip label="Credit evidence summary">
            <Metric
              label="Consented businesses"
              value={String(room.data.metrics.consentingBusinesses)}
              detail="Layer-3 permission current"
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              tone="positive"
            />
            <Metric
              label="Assessed invoices"
              value={String(room.data.metrics.assessedInvoices)}
              detail={`Data through ${dateTime(room.data.dataThrough)}`}
              icon={<Database className="size-4" aria-hidden="true" />}
              tone="info"
            />
            <Metric
              label="Eligibility rate"
              value={percent(room.data.metrics.eligibleRate)}
              detail={`${room.data.metrics.manualReviewInvoices} routed to review`}
              icon={<BarChart3 className="size-4" aria-hidden="true" />}
              tone="positive"
            />
            <Metric
              label="Evidence coverage"
              value={percent(room.data.metrics.settlementObservationCoverage)}
              detail="Approved settlement sources"
              icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
            />
          </MetricStrip>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="space-y-4"
          >
            <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-md border border-slate-200 bg-white p-1">
              <TabsTrigger value="cohorts">Cohorts</TabsTrigger>
              <TabsTrigger value="assurance">Method & assurance</TabsTrigger>
              <TabsTrigger value="access">Access history</TabsTrigger>
            </TabsList>

            <TabsContent value="cohorts" className="space-y-5">
              <section className="overflow-hidden border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-5 py-4">
                  <h2 className="text-base font-extrabold text-slate-950">
                    Quarterly eligibility cohorts
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Cells below {room.data.privacy.minimumCohortSize} distinct
                    businesses are omitted. Rates are structural, not loss
                    forecasts.
                  </p>
                </div>
                {room.data.cohorts.length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-slate-500">
                    Every current cohort is below the privacy threshold.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[58rem] text-left text-sm">
                      <caption className="sr-only">
                        Quarterly credit cohorts grouped by fixed amount band
                      </caption>
                      <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                        <tr>
                          <th className="px-4 py-3 font-bold" scope="col">
                            Period
                          </th>
                          <th className="px-4 py-3 font-bold" scope="col">
                            Amount band
                          </th>
                          <th
                            className="px-4 py-3 text-right font-bold"
                            scope="col"
                          >
                            Businesses
                          </th>
                          <th
                            className="px-4 py-3 text-right font-bold"
                            scope="col"
                          >
                            Invoices
                          </th>
                          <th
                            className="px-4 py-3 text-right font-bold"
                            scope="col"
                          >
                            Eligible
                          </th>
                          <th
                            className="px-4 py-3 text-right font-bold"
                            scope="col"
                          >
                            Manual review
                          </th>
                          <th
                            className="px-4 py-3 text-right font-bold"
                            scope="col"
                          >
                            Settlement evidence
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {room.data.cohorts.map((cohort) => (
                          <tr
                            key={`${cohort.period}-${cohort.amountBand}`}
                            className="hover:bg-slate-50/70"
                          >
                            <th
                              className="px-4 py-3 font-bold text-slate-900"
                              scope="row"
                            >
                              {cohort.period}
                            </th>
                            <td className="px-4 py-3 text-slate-600">
                              {amountBand[cohort.amountBand]}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {cohort.businesses}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {cohort.assessedInvoices}
                            </td>
                            <td className="px-4 py-3 text-right font-bold tabular-nums text-emerald-700">
                              {percent(cohort.eligibleRate)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-amber-700">
                              {percent(cohort.manualReviewRate)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {percent(cohort.settlementObservationCoverage)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </TabsContent>

            <TabsContent value="assurance">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
                <section className="border border-slate-200 bg-white p-5">
                  <h2 className="flex items-center gap-2 text-base font-extrabold text-slate-950">
                    <Fingerprint
                      className="size-4 text-teal-700"
                      aria-hidden="true"
                    />
                    Mandatory evidence coverage
                  </h2>
                  <div className="mt-6 space-y-5">
                    <CoverageRow
                      label="Buyer confirmation"
                      value={room.data.metrics.buyerConfirmationCoverage}
                    />
                    <CoverageRow
                      label="Approved settlement observation"
                      value={room.data.metrics.settlementObservationCoverage}
                    />
                    <CoverageRow
                      label="Current verified KYB"
                      value={room.data.metrics.kybCoverage}
                    />
                  </div>
                </section>
                <section className="border border-slate-200 bg-white p-5">
                  <h2 className="flex items-center gap-2 text-base font-extrabold text-slate-950">
                    <Landmark
                      className="size-4 text-teal-700"
                      aria-hidden="true"
                    />
                    Control posture
                  </h2>
                  <dl className="mt-5 space-y-4 text-sm">
                    <div>
                      <dt className="text-xs font-bold text-slate-500">
                        DPA reference
                      </dt>
                      <dd className="mt-1 break-all font-mono text-xs text-slate-900">
                        {room.data.assurance.dpaReference}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-500">
                        Access valid until
                      </dt>
                      <dd className="mt-1 font-bold text-slate-900">
                        {dateTime(room.data.assurance.accessValidUntil)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-500">
                        Scorecard versions
                      </dt>
                      <dd className="mt-1 text-slate-700">
                        {room.data.assurance.scorecardVersions.join(", ") ||
                          "No released cohort"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-500">
                        Ruleset versions
                      </dt>
                      <dd className="mt-1 text-slate-700">
                        {room.data.assurance.rulesetVersions.join(", ") ||
                          "No released cohort"}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </TabsContent>

            <TabsContent value="access">
              <section className="overflow-hidden border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-5 py-4">
                  <h2 className="text-base font-extrabold text-slate-950">
                    Bank access history
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Recent views under this bank&apos;s DPA-bound access
                    profile.
                  </p>
                </div>
                {access.isError ? (
                  <div className="p-5">
                    <QueryError
                      thing="the access history"
                      onRetry={() => access.refetch()}
                    />
                  </div>
                ) : access.isLoading ? (
                  <div className="space-y-2 p-5">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton key={index} className="h-10" />
                    ))}
                  </div>
                ) : (access.data ?? []).length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-slate-500">
                    No prior access events.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {(access.data ?? []).map((event) => (
                      <li
                        key={event.id}
                        className="grid gap-2 px-5 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <Clock3
                            className="size-4 shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <span className="font-bold text-slate-900">
                            {event.action === "overview"
                              ? "Data Room viewed"
                              : "Access history viewed"}
                          </span>
                          <span
                            className={pillClasses(
                              event.outcome === "served" ? "emerald" : "slate",
                            )}
                          >
                            {event.outcome}
                          </span>
                        </div>
                        <time
                          className="text-xs text-slate-500"
                          dateTime={event.createdAt}
                        >
                          {dateTime(event.createdAt)}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </TabsContent>
          </Tabs>

          <p className="text-xs text-slate-500">
            Access evidence {room.data.accessEventId}. Exact amounts, direct
            identifiers and raw exports are disabled by design.
          </p>
        </>
      )}
    </div>
  );
}
