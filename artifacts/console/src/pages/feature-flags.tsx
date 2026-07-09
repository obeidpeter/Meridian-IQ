import { useMemo } from "react";
import {
  useGetMe,
  useListFeatureFlags,
  useUpdateFeatureFlag,
  getListFeatureFlagsQueryKey,
} from "@workspace/api-client-react";
import type { FeatureFlag } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Info } from "lucide-react";
import { formatDateTime } from "@/lib/format";

// Flags ship dark and are flipped per release gate (PL-02). Grouping by
// release tag mirrors how the roadmap reasons about them.
const RELEASE_ORDER = ["R0", "R1", "R2", "R3", "R4"];

function releaseRank(tag: string): number {
  const i = RELEASE_ORDER.indexOf(tag);
  return i === -1 ? RELEASE_ORDER.length : i;
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
  return (
    <div
      className="flex items-start justify-between gap-4 py-3"
      data-testid={`flag-${flag.key}`}
    >
      <div className="min-w-0">
        <p className="font-medium text-sm">
          {flag.key}
          <span className="ml-2 text-xs font-normal text-muted-foreground border rounded-full px-2 py-0.5">
            {flag.releaseTag}
          </span>
        </p>
        {flag.description && (
          <p className="text-xs text-muted-foreground mt-1">{flag.description}</p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5">
          Updated {formatDateTime(flag.updatedAt)}
        </p>
      </div>
      <Switch
        checked={flag.enabled}
        disabled={!canWrite || saving}
        onCheckedChange={(checked) => onToggle(flag, checked)}
        aria-label={`Toggle ${flag.key}`}
        data-testid={`switch-${flag.key}`}
      />
    </div>
  );
}

export function FeatureFlags() {
  const { data: me } = useGetMe();
  const { data: flags, isLoading } = useListFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateFeatureFlag();

  const canWrite = (me?.capabilities ?? []).includes("flags.write");

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

  const handleToggle = (flag: FeatureFlag, enabled: boolean) => {
    update.mutate(
      { key: flag.key, data: { enabled } },
      {
        onSuccess: () => {
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
        onError: () =>
          toast({
            title: `Could not update ${flag.key}`,
            variant: "destructive",
          }),
      },
    );
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
          Release-tagged surfaces ship dark and go live per gate (PL-02).
        </p>
      </div>

      {!canWrite && (
        <p
          className="text-sm text-muted-foreground flex items-center gap-2"
          data-testid="text-read-only"
        >
          <Info className="w-4 h-4" />
          Read-only view — only the Compliance Desk operator can flip release
          flags.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground" data-testid="text-empty">
          No flags seeded yet.
        </p>
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
                    onToggle={handleToggle}
                    saving={update.isPending}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
