import { useMemo, useState } from "react";
import {
  useGetMe,
  useListFeatureFlags,
  useUpdateFeatureFlag,
  useListFeatureFlagOverrides,
  useSetFeatureFlagOverride,
  useClearFeatureFlagOverride,
  useListFirms,
  getListFeatureFlagsQueryKey,
  getListFeatureFlagOverridesQueryKey,
} from "@workspace/api-client-react";
import type {
  FeatureFlag,
  FeatureFlagOverride,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { serverErrorToast } from "@/lib/errors";
import {
  AlertTriangle,
  Info,
  ToggleRight,
  Users,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";

// Flags ship dark and are flipped per release gate (PL-02). Grouping by
// release tag mirrors how the roadmap reasons about them. Each flag also
// carries its pilot cohort (R99): the firms whose override lights or darkens
// it ahead of — or against — the platform default, each with who set it and
// why, every change on the audit chain.
const RELEASE_ORDER = ["R0", "R1", "R2", "R3", "R4"];
const REASON_MIN = 3;

function releaseRank(tag: string): number {
  const i = RELEASE_ORDER.indexOf(tag);
  return i === -1 ? RELEASE_ORDER.length : i;
}

function FlagCohort({
  flag,
  canWrite,
}: {
  flag: FeatureFlag;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: overrides,
    isLoading,
    error,
    refetch,
  } = useListFeatureFlagOverrides(flag.key, {
    query: { queryKey: getListFeatureFlagOverridesQueryKey(flag.key) },
  });
  const { data: firms } = useListFirms();
  const setOverride = useSetFeatureFlagOverride();
  const clearOverride = useClearFeatureFlagOverride();

  const [firmId, setFirmId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [reason, setReason] = useState("");
  const [busyFirm, setBusyFirm] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getListFeatureFlagOverridesQueryKey(flag.key),
    });
    queryClient.invalidateQueries({ queryKey: getListFeatureFlagsQueryKey() });
  };

  const canSubmit =
    canWrite && firmId !== "" && reason.trim().length >= REASON_MIN;

  const submit = () => {
    if (!canSubmit) return;
    setBusyFirm(firmId);
    setOverride.mutate(
      { key: flag.key, data: { firmId, enabled, reason: reason.trim() } },
      {
        onSuccess: (row) => {
          toast({
            title: `${row.firmName}: ${flag.key} ${row.enabled ? "on" : "off"}`,
            description: "Recorded on the audit chain with your reason.",
          });
          setFirmId("");
          setReason("");
          refresh();
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not set the override",
            fallback: "Try again.",
          }),
        onSettled: () => setBusyFirm(null),
      },
    );
  };

  const clear = (row: FeatureFlagOverride) => {
    setBusyFirm(row.firmId);
    clearOverride.mutate(
      { key: flag.key, firmId: row.firmId },
      {
        onSuccess: () => {
          toast({
            title: `${row.firmName} back on the platform default`,
            description: `${flag.key} now follows the platform switch for this firm.`,
          });
          refresh();
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not clear the override",
            fallback: "Try again.",
          }),
        onSettled: () => setBusyFirm(null),
      },
    );
  };

  return (
    <div
      className="mt-3 rounded-md border bg-muted/30 p-3 space-y-3"
      data-testid={`cohort-${flag.key}`}
    >
      {isLoading ? (
        <Skeleton className="h-10" />
      ) : error ? (
        <QueryError thing="pilot firm group" onRetry={() => refetch()} />
      ) : (overrides ?? []).length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`text-cohort-empty-${flag.key}`}
        >
          No firm overrides — every firm follows the platform switch.
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {(overrides ?? []).map((row) => (
            <li
              key={row.firmId}
              className="flex items-start justify-between gap-3 py-2"
              data-testid={`override-${flag.key}-${row.firmId}`}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {row.firmName}
                  <span
                    className={`ml-2 text-xs font-normal rounded-full px-2 py-0.5 ${
                      row.enabled
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200"
                    }`}
                  >
                    {row.enabled ? "On for this firm" : "Off for this firm"}
                  </span>
                </p>
                {row.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {row.reason}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  Set {formatDateTime(row.updatedAt)}
                </p>
              </div>
              {canWrite && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyFirm === row.firmId}
                  onClick={() => clear(row)}
                  data-testid={`button-clear-override-${flag.key}-${row.firmId}`}
                >
                  Clear
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto_2fr_auto] sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          data-testid={`form-override-${flag.key}`}
        >
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={firmId}
            onChange={(e) => setFirmId(e.target.value)}
            aria-label={`Firm to override ${flag.key} for`}
            data-testid={`select-override-firm-${flag.key}`}
          >
            <option value="">Choose a firm…</option>
            {(firms ?? []).map((firm) => (
              <option key={firm.id} value={firm.id}>
                {firm.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={`Override direction for ${flag.key}`}
              data-testid={`switch-override-enabled-${flag.key}`}
            />
            {enabled ? "On" : "Off"}
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why (recorded on the audit chain)"
            maxLength={280}
            aria-label={`Reason for the ${flag.key} override`}
            data-testid={`input-override-reason-${flag.key}`}
          />
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit || busyFirm !== null}
            data-testid={`button-set-override-${flag.key}`}
          >
            Set override
          </Button>
        </form>
      )}
    </div>
  );
}

function FlagRow({
  flag,
  canWrite,
  onToggle,
  saving,
}: {
  flag: FeatureFlag;
  canWrite: boolean;
  onToggle: (flag: FeatureFlag, enabled: boolean) => void;
  saving: boolean;
}) {
  const [cohortOpen, setCohortOpen] = useState(false);
  return (
    <div className="py-3" data-testid={`flag-${flag.key}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-sm">
            {flag.key}
            <span className="ml-2 text-xs font-normal text-muted-foreground border rounded-full px-2 py-0.5">
              {flag.releaseTag}
            </span>
          </p>
          {flag.description && (
            <p className="text-xs text-muted-foreground mt-1">
              {flag.description}
            </p>
          )}
          {flag.requires.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Requires {flag.requires.join(", ")}
            </p>
          )}
          {flag.unmetPrerequisites.length > 0 && (
            <p
              className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
              role="status"
              data-testid={`flag-prerequisites-${flag.key}`}
            >
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              Enable {flag.unmetPrerequisites.join(", ")} first
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            Updated {formatDateTime(flag.updatedAt)}
          </p>
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            onClick={() => setCohortOpen((open) => !open)}
            aria-expanded={cohortOpen}
            data-testid={`button-cohort-${flag.key}`}
          >
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            Pilot firms ({flag.overrideCount})
            {cohortOpen ? (
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
        <Switch
          checked={flag.enabled}
          disabled={!canWrite || saving}
          onCheckedChange={(checked) => onToggle(flag, checked)}
          aria-label={`Toggle ${flag.key}`}
          data-testid={`switch-${flag.key}`}
        />
      </div>
      {cohortOpen && <FlagCohort flag={flag} canWrite={canWrite} />}
    </div>
  );
}

export function FeatureFlags() {
  usePageTitle("Feature flags");
  const { data: me } = useGetMe();
  const { data: flags, isLoading, error, refetch } = useListFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateFeatureFlag();

  const canWrite = (me?.capabilities ?? []).includes("flags.write");

  // Track which key is saving so only that Switch disables while the
  // mutation runs.
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Disabling darkens the surface for EVERY firm the moment the mutation
  // lands, so it is confirm-gated; enabling stays a single flick.
  const [disableTarget, setDisableTarget] = useState<FeatureFlag | null>(null);

  const groups = useMemo(() => {
    const byTag = new Map<string, FeatureFlag[]>();
    for (const flag of flags ?? []) {
      const list = byTag.get(flag.releaseTag) ?? [];
      list.push(flag);
      byTag.set(flag.releaseTag, list);
    }
    return [...byTag.entries()]
      .sort((a, b) => releaseRank(a[0]) - releaseRank(b[0]))
      .map(([tag, list]) => ({
        tag,
        flags: list.sort((a, b) => a.key.localeCompare(b.key)),
      }));
  }, [flags]);

  const runToggle = (flag: FeatureFlag, enabled: boolean) => {
    setSavingKey(flag.key);
    update.mutate(
      { key: flag.key, data: { enabled } },
      {
        onSuccess: () => {
          // Settle the controlled Switch IMMEDIATELY: the invalidation
          // below refetches asynchronously, and a second click landing
          // before it resolves reads the STALE `enabled` and re-sends the
          // same state (on a slow runner the round-trip toggle then never
          // reaches "disabled"). The server confirmed the write — make the
          // cache say so now.
          queryClient.setQueryData<FeatureFlag[]>(
            getListFeatureFlagsQueryKey(),
            (prev) =>
              prev?.map((f) => (f.key === flag.key ? { ...f, enabled } : f)),
          );
          toast({
            title: `${flag.key} ${enabled ? "enabled" : "disabled"}`,
            description: enabled
              ? "The surface is live for every firm."
              : "The surface is dark again (routes answer 404).",
          });
          queryClient.invalidateQueries({
            queryKey: getListFeatureFlagsQueryKey(),
          });
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: `Could not update ${flag.key}`,
            fallback: "Try again.",
          }),
        onSettled: () => setSavingKey(null),
      },
    );
  };

  const requestToggle = (flag: FeatureFlag, enabled: boolean) => {
    if (!enabled) {
      setDisableTarget(flag);
      return;
    }
    runToggle(flag, enabled);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Feature flags
        </h1>
        <p className="text-muted-foreground mt-1">
          New features stay off until their release requirements are met. A
          firm-specific setting can enable a pilot before the platform-wide
          release. Every exception requires a reason and is saved in the audit
          log.
        </p>
      </div>

      {!canWrite && (
        <p
          className="text-sm text-muted-foreground flex items-center gap-2"
          data-testid="text-read-only"
        >
          <Info className="w-4 h-4" aria-hidden="true" />
          Read-only view. Only a compliance desk operator can change release
          flags or pilot firm settings.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent className="space-y-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-14" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <QueryError thing="feature flags" onRetry={() => refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={ToggleRight}
            title="No flags seeded yet"
            description="Release flags are seeded by the platform — they appear here once the platform registers them."
          />
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.tag} data-testid={`card-release-${group.tag}`}>
            <CardHeader>
              <CardTitle className="text-base">Release {group.tag}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {group.flags.map((flag) => (
                  <FlagRow
                    key={flag.key}
                    flag={flag}
                    canWrite={canWrite}
                    onToggle={requestToggle}
                    saving={savingKey === flag.key}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        ))
      )}
      <AlertDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn off {disableTarget?.key ?? "this flag"} for every firm?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The surface goes dark immediately — its routes answer 404 for all
              tenants until the flag is switched back on. Firms with an explicit
              "on" override keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it live</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (disableTarget) runToggle(disableTarget, false);
                setDisableTarget(null);
              }}
              data-testid="button-confirm-disable-flag"
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
