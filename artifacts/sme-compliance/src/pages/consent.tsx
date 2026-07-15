import { useState } from "react";
import {
  useGetMe,
  useListConsent,
  useRecordConsent,
  getListConsentQueryKey,
} from "@workspace/api-client-react";
import type { ConsentRecord } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck,
  ShieldOff,
  Lock,
  Info,
  FileCheck2,
  BarChart3,
  Landmark,
} from "lucide-react";
import { formatDate, humanize, pillClasses } from "@/lib/format";

// Consent flows v1 (R1, CORE-03/C6): the three-layer architecture surfaced.
// Layer 1 powers submission/vault/alerts; layer 2 anonymized benchmarking;
// layer 3 (credit readiness) ships dark and is presented as a future benefit.

const LAYERS = [
  {
    layer: 1,
    title: "Compliance & submission",
    scope: "compliance_submission",
    icon: FileCheck2,
    description:
      "Lets MeridianIQ validate, submit and vault your invoices, and send deadline alerts. Without it, nothing can be submitted on your behalf.",
    dormant: false,
  },
  {
    layer: 2,
    title: "Anonymized benchmarking",
    scope: "anonymized_benchmark",
    icon: BarChart3,
    description:
      "Allows your data to feed anonymized, aggregate industry benchmarks. Never shown with your name attached.",
    dormant: false,
  },
  {
    layer: 3,
    title: "Credit readiness",
    scope: "credit_scoring",
    icon: Landmark,
    description:
      "One day, your compliance history could help you get paid early against invoices you've already earned. This layer activates later, only with your explicit consent.",
    dormant: true,
  },
] as const;

const SCOPE_TITLES: Record<string, string> = Object.fromEntries(
  LAYERS.map((l) => [l.scope, l.title]),
);

function scopeTitle(scope: string): string {
  return SCOPE_TITLES[scope] ?? humanize(scope);
}

// Latest grant/revoke wins per layer.
function layerStatus(records: ConsentRecord[], layer: number): ConsentRecord | null {
  const forLayer = records
    .filter((r) => r.layer === layer)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return forLayer[0] ?? null;
}

export function Consent() {
  usePageTitle("Consent");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const canWrite = (me?.capabilities ?? []).includes("consent.write");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: records,
    isLoading,
    isError,
    refetch,
  } = useListConsent(clientPartyId, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListConsentQueryKey(clientPartyId),
    },
  });
  const record = useRecordConsent();
  // Only the control that fired shows pending state.
  const [actingLayer, setActingLayer] = useState<number | null>(null);

  const act = (layer: number, scope: string, action: "grant" | "revoke") => {
    setActingLayer(layer);
    record.mutate(
      {
        id: clientPartyId,
        data: { layer, action, scope, basis: "consent", channel: "app" },
      },
      {
        onSuccess: () => {
          toast({
            title: `Layer ${layer} ${action === "grant" ? "granted" : "revoked"}`,
            description:
              action === "revoke"
                ? "Revocation takes effect immediately — dependent features stop within a minute."
                : undefined,
          });
          queryClient.invalidateQueries({
            queryKey: getListConsentQueryKey(clientPartyId),
          });
        },
        onError: () =>
          toast({ title: "Could not record consent", variant: "destructive" }),
        onSettled: () => setActingLayer(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consent"
        description="Every permission on your data, recorded with lineage — grants and revocations are ledger events, never edits."
      />

      <RequireClientScope thing="consent ledger">
        <div className="space-y-6">
          {!canWrite && (
            <p
              className="text-sm text-muted-foreground flex items-center gap-2"
              data-testid="text-consent-readonly"
            >
              <Info className="w-4 h-4" aria-hidden="true" />
              Read-only view — granting or revoking consent is for the client's own
              account (or the firm admin).
            </p>
          )}

          {isLoading ? (
            <SkeletonList count={3} itemClassName="h-32" className="space-y-4" />
          ) : isError ? (
            <QueryError thing="the consent ledger" onRetry={() => refetch()} />
          ) : (
            <>
              <div className="space-y-4">
                {LAYERS.map((l) => {
                  const Icon = l.icon;
                  const current = layerStatus(records ?? [], l.layer);
                  const granted = current?.action === "grant";
                  const acting = actingLayer === l.layer && record.isPending;
                  return (
                    <Card key={l.layer} data-testid={`consent-layer-${l.layer}`}>
                      <CardHeader>
                        <CardTitle className="flex items-center justify-between gap-2 text-base">
                          <span className="flex items-center gap-2">
                            <Icon className="w-4 h-4 text-primary" aria-hidden="true" />
                            Layer {l.layer} · {l.title}
                          </span>
                          {l.dormant ? (
                            <span className={pillClasses("slate")}>
                              <Lock className="w-3 h-3" aria-hidden="true" /> Not yet available
                            </span>
                          ) : granted ? (
                            <span className={pillClasses("emerald")}>
                              <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Granted
                            </span>
                          ) : (
                            <span className={pillClasses("slate")}>
                              <ShieldOff className="w-3 h-3" aria-hidden="true" /> Not granted
                            </span>
                          )}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground">{l.description}</p>
                        {current && (
                          <p className="text-xs text-muted-foreground">
                            Last change: {current.action === "grant" ? "Granted" : "Revoked"} ·{" "}
                            {formatDate(current.createdAt)} via {humanize(current.channel)}
                          </p>
                        )}
                        {!l.dormant && canWrite && (
                          <div className="flex gap-2">
                            {granted ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-destructive hover:text-destructive"
                                disabled={acting}
                                onClick={() => act(l.layer, l.scope, "revoke")}
                                data-testid={`button-revoke-${l.layer}`}
                              >
                                <ShieldOff className="w-4 h-4 mr-1" aria-hidden="true" />
                                {acting ? "Revoking…" : "Revoke"}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={acting}
                                onClick={() => act(l.layer, l.scope, "grant")}
                                data-testid={`button-grant-${l.layer}`}
                              >
                                <ShieldCheck className="w-4 h-4 mr-1" aria-hidden="true" />
                                {acting ? "Granting…" : "Grant"}
                              </Button>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Consent history</CardTitle>
                </CardHeader>
                <CardContent>
                  {(records ?? []).length === 0 ? (
                    <EmptyState
                      icon={ShieldCheck}
                      title="No consent events yet"
                      description="Grants and revocations you make appear here as ledger events, each with its own timestamp and lineage."
                      className="px-0 py-8 justify-center"
                    />
                  ) : (
                    <div className="divide-y">
                      {[...(records ?? [])]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((r) => (
                          <div
                            key={r.id}
                            className="py-2 text-sm flex items-center justify-between gap-3"
                          >
                            <span>
                              <span
                                className={`font-medium ${
                                  r.action === "grant"
                                    ? "text-emerald-700 dark:text-emerald-400"
                                    : "text-red-700 dark:text-red-400"
                                }`}
                              >
                                {r.action === "grant" ? "Granted" : "Revoked"}
                              </span>{" "}
                              · Layer {r.layer} · {scopeTitle(r.scope)}
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {formatDate(r.createdAt)} · {humanize(r.channel)}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </RequireClientScope>
    </div>
  );
}
