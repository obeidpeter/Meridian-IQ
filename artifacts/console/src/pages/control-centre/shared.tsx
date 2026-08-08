import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, CircleDashed } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { pillClasses } from "@/lib/format";

export function WorkspaceLoading() {
  return (
    <div className="space-y-6" aria-label="Loading workspace">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-none bg-white" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

export function StatusPill({
  status,
  children,
}: {
  status: string;
  children?: ReactNode;
}) {
  const tone =
    status === "healthy" ||
    status === "ready" ||
    status === "achieved" ||
    status === "scale_ready"
      ? "emerald"
      : status === "critical" || status === "overdue" || status === "incident"
        ? "red"
        : status === "watch" ||
            status === "partial" ||
            status === "due_soon" ||
            status === "stale"
          ? "amber"
          : status === "live" || status === "proving"
            ? "blue"
            : "slate";
  return <span className={pillClasses(tone)}>{children ?? status}</span>;
}

export function ControlRow({
  title,
  detail,
  status,
  statusLabel,
  action,
}: {
  title: string;
  detail: string;
  status: string;
  statusLabel?: string;
  action?: ReactNode;
}) {
  const Icon =
    status === "healthy" || status === "ready"
      ? CheckCircle2
      : status === "critical"
        ? AlertCircle
        : status === "watch" || status === "partial"
          ? Clock3
          : CircleDashed;
  return (
    <div className="grid gap-3 border-b border-slate-200 px-4 py-4 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <span className="grid size-9 place-items-center rounded-md bg-slate-100 text-slate-600">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-slate-950">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-slate-500">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill status={status}>{statusLabel}</StatusPill>
        {action}
      </div>
    </div>
  );
}

export function fmtHours(value: number | null | undefined): string {
  if (value === null || value === undefined) return "No data";
  if (value < 1) return `${Math.round(value * 60)}m`;
  return `${value.toFixed(value < 10 ? 1 : 0)}h`;
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "No data";
  return `${Math.round(value * 100)}%`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-NG", { notation: "compact" }).format(value);
}
