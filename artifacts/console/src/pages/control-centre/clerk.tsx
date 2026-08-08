import { Link } from "wouter";
import {
  getGetClerkAssuranceQueryKey,
  useGetClerkAssurance,
} from "@workspace/api-client-react";
import { Metric, MetricStrip } from "@workspace/web-ui";
import {
  Bot,
  CheckCircle2,
  Gauge,
  ScanSearch,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/lib/format";
import { compactNumber, ControlRow, pct, WorkspaceLoading } from "./shared";

export function ClerkAssuranceWorkspace() {
  const query = useGetClerkAssurance({
    query: { queryKey: getGetClerkAssuranceQueryKey(), staleTime: 60_000 },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError thing="Clerk assurance" onRetry={() => query.refetch()} />
    );
  }
  const data = query.data;
  const critical = data.guardrails.filter(
    (guardrail) => guardrail.status === "critical",
  ).length;
  const watch = data.guardrails.filter(
    (guardrail) => guardrail.status === "watch",
  ).length;

  return (
    <div className="space-y-6">
      <MetricStrip label="Clerk assurance summary">
        <Metric
          label="Model calls (30d)"
          value={compactNumber(data.calls30d)}
          detail={`${compactNumber(data.tokens30d)} measured tokens`}
          icon={<Bot className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Pending human review"
          value={String(data.pendingReview)}
          detail={`${data.decidedCases30d} decisions in 30 days`}
          icon={<ScanSearch className="size-4" aria-hidden="true" />}
          tone={data.pendingReview > 0 ? "warning" : "positive"}
        />
        <Metric
          label="Output validity"
          value={data.calls30d > 0 ? pct(1 - data.invalidRate30d) : "No data"}
          detail={
            data.calls30d > 0
              ? `${pct(data.errorRate30d)} runtime error rate`
              : "No measured model calls"
          }
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone={
            data.calls30d > 0 && data.invalidRate30d <= 0.02
              ? "positive"
              : "warning"
          }
        />
        <Metric
          label="Inference p95"
          value={
            data.latencyP95Ms === null ? "No data" : `${data.latencyP95Ms}ms`
          }
          detail="30-day provider latency"
          icon={<Timer className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <section className="grid gap-5 rounded-lg border border-emerald-800 bg-emerald-900 px-5 py-5 text-white lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
        <span className="grid size-11 place-items-center rounded-md bg-lime-300 text-emerald-950">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-base font-extrabold">
            Human authority remains the control boundary
          </p>
          <p className="mt-1 text-sm leading-6 text-white/70">
            Clerk extracts, retrieves and proposes. Filing, sending, approval
            and rejection remain attributable human acts.
          </p>
        </div>
        <Button
          asChild
          className="bg-lime-300 text-emerald-950 hover:bg-lime-200"
        >
          <Link href="/clerk">Open review queue</Link>
        </Button>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_20rem]">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-extrabold text-slate-950">
                Operational guardrails
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Deterministic checks over the inference ledger, eval corpus and
                release flags.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/clerk/health">
                <Gauge className="size-4" aria-hidden="true" /> Detailed health
              </Link>
            </Button>
          </div>
          {data.guardrails.map((guardrail) => (
            <ControlRow
              key={guardrail.key}
              title={guardrail.label}
              detail={guardrail.detail}
              status={guardrail.status}
              statusLabel={humanize(guardrail.status)}
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link href={guardrail.actionHref}>Open</Link>
                </Button>
              }
            />
          ))}
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase text-slate-400">
              Assurance posture
            </p>
            <div className="mt-4 flex items-end gap-2">
              <p className="text-4xl font-extrabold tabular-nums text-slate-950">
                {critical}
              </p>
              <p className="pb-1 text-sm font-semibold text-slate-500">
                critical controls
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-200 py-3 text-center">
              <div>
                <p className="text-xl font-extrabold tabular-nums text-amber-700">
                  {watch}
                </p>
                <p className="text-[11px] font-bold text-slate-400">Watch</p>
              </div>
              <div>
                <p className="text-xl font-extrabold tabular-nums text-emerald-700">
                  {data.guardrails.length - critical - watch}
                </p>
                <p className="text-[11px] font-bold text-slate-400">Healthy</p>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase text-slate-400">
              Latest eval
            </p>
            <dl className="mt-4 space-y-4">
              <div>
                <dt className="text-xs text-slate-500">Field accuracy</dt>
                <dd className="mt-1 text-2xl font-extrabold text-slate-950">
                  {pct(data.latestEvalAccuracy)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Injection resistance</dt>
                <dd className="mt-1 text-2xl font-extrabold text-slate-950">
                  {pct(data.latestInjectionResistance)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Grounding violations</dt>
                <dd
                  className={`mt-1 text-2xl font-extrabold ${data.groundingViolations30d > 0 ? "text-red-700" : "text-emerald-700"}`}
                >
                  {data.groundingViolations30d}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
