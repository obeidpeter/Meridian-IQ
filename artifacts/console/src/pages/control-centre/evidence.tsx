import { useState } from "react";
import { Link } from "wouter";
import {
  getGetEvidenceVaultQueryKey,
  useGetEvidenceVault,
  type EvidenceVaultItem,
} from "@workspace/api-client-react";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkQueue,
  type WorkQueueItem,
} from "@workspace/web-ui";
import {
  Archive,
  Download,
  FileCheck2,
  FileClock,
  Fingerprint,
  Landmark,
  LockKeyhole,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { formatDateTime, humanize } from "@/lib/format";
import { ControlRow, pct, WorkspaceLoading } from "./shared";

type EvidenceFilter =
  | "all"
  | "invoice_stamp"
  | "filing_acknowledgement"
  | "obligation_resolution"
  | "settlement_signal";

function evidenceIcon(kind: EvidenceVaultItem["kind"]) {
  if (kind === "invoice_stamp")
    return <Fingerprint className="size-4" aria-hidden="true" />;
  if (kind === "filing_acknowledgement")
    return <FileCheck2 className="size-4" aria-hidden="true" />;
  if (kind === "obligation_resolution")
    return <Landmark className="size-4" aria-hidden="true" />;
  return <ReceiptText className="size-4" aria-hidden="true" />;
}

export function EvidenceVaultWorkspace() {
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const query = useGetEvidenceVault({
    query: { queryKey: getGetEvidenceVaultQueryKey(), staleTime: 60_000 },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError thing="evidence vault" onRetry={() => query.refetch()} />
    );
  }
  const data = query.data;
  const filtered = data.items.filter(
    (item) => filter === "all" || item.kind === filter,
  );
  const queueItems: WorkQueueItem[] = filtered.map((item) => ({
    id: item.key,
    title: item.title,
    description: [item.clientName, item.firmName, item.reference]
      .filter(Boolean)
      .join(" / "),
    tone: item.integrity === "recorded" ? "neutral" : "positive",
    icon: evidenceIcon(item.kind),
    meta: (
      <span>
        {humanize(item.integrity)} / {formatDateTime(item.recordedAt)}
      </span>
    ),
    action: (
      <Button asChild size="sm" variant="outline">
        <Link href={item.actionHref}>Open source</Link>
      </Button>
    ),
  }));

  return (
    <div className="space-y-6">
      <MetricStrip label="Evidence vault summary">
        <Metric
          label="Indexed artifacts"
          value={String(data.totalArtifacts)}
          detail={`${data.artifactsLast30d} recorded in 30 days`}
          icon={<Archive className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Audit chain"
          value={data.auditChainValid ? "Verified" : "Broken"}
          detail={`${data.auditEventCount} events checked`}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
          tone={data.auditChainValid ? "positive" : "critical"}
        />
        <Metric
          label="Retention coverage"
          value={pct(data.retentionCoverageRate)}
          detail="Submitted invoices covered"
          icon={<FileClock className="size-4" aria-hidden="true" />}
          tone={
            data.retentionCoverageRate === null ||
            data.retentionCoverageRate >= 0.9
              ? "positive"
              : "warning"
          }
        />
        <Metric
          label="Legal holds"
          value={String(data.legalHolds)}
          detail="Records preserved beyond expiry"
          icon={<LockKeyhole className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)]">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-extrabold text-slate-950">
                Enterprise trust controls
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Runtime evidence for integrity, retention and human authority.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/audit">Audit workspace</Link>
            </Button>
          </div>
          {data.trustControls.map((control) => (
            <ControlRow
              key={control.key}
              title={control.label}
              detail={control.detail}
              status={control.status}
              statusLabel={humanize(control.status)}
            />
          ))}
        </section>

        <section className="flex min-h-[20rem] flex-col justify-between rounded-lg border border-slate-200 bg-[#082f31] p-5 text-white">
          <div>
            <span className="grid size-10 place-items-center rounded-md bg-lime-300 text-[#082f31]">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-6 text-xs font-bold uppercase text-lime-300">
              Auditor package
            </p>
            <h2 className="mt-2 text-xl font-extrabold">
              Verifiable ledger export
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/65">
              Export sequence numbers and both chain hashes for independent
              review.
            </p>
          </div>
          <Button
            asChild
            className="mt-6 w-full bg-lime-300 text-[#082f31] hover:bg-lime-200"
          >
            <a href="/api/audit/export/csv">
              <Download className="size-4" aria-hidden="true" /> Export audit
              CSV
            </a>
          </Button>
        </section>
      </div>

      <WorkQueue
        title="Evidence index"
        description="Newest durable artifacts across stamps, filings, authority responses and settlement signals."
        items={queueItems}
        emptyTitle="No evidence in this view"
        emptyDescription="The selected evidence category has no indexed records."
        toolbar={
          <SegmentedControl<EvidenceFilter>
            label="Filter evidence"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: data.items.length },
              {
                value: "invoice_stamp",
                label: "Stamps",
                count: data.items.filter(
                  (item) => item.kind === "invoice_stamp",
                ).length,
              },
              {
                value: "filing_acknowledgement",
                label: "Filings",
                count: data.items.filter(
                  (item) => item.kind === "filing_acknowledgement",
                ).length,
              },
              {
                value: "obligation_resolution",
                label: "Authority",
                count: data.items.filter(
                  (item) => item.kind === "obligation_resolution",
                ).length,
              },
              {
                value: "settlement_signal",
                label: "Settlement",
                count: data.items.filter(
                  (item) => item.kind === "settlement_signal",
                ).length,
              },
            ]}
          />
        }
      />
    </div>
  );
}
