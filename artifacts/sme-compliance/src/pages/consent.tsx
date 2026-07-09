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
import { Skeleton } from "@/components/ui/skeleton";
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
import { formatDate } from "@/lib/format";

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

// Latest grant/revoke wins per layer.
function layerStatus(records: ConsentRecord[], layer: number): ConsentRecord | null {
  const forLayer = records
    .filter((r) => r.layer === layer)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return forLayer[0] ?? null;
}

export function Consent() {
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const canWrite = (me?.capabilities ?? []).includes("consent.write");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: records, isLoading } = useListConsent(clientPartyId, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListConsentQueryKey(clientPartyId),
    },
  });
  const record = useRecordConsent();

  const act = (layer: number, scope: string, action: "grant" | "revoke") => {
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
      },
    );
  };

  if (!clientPartyId) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Consent
        </h1>
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            Your account isn't scoped to a client business, so there's no
            consent ledger to show here. Sign in with a client account.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Consent
        </h1>
        <p className="text-muted-foreground mt-1">
          Every permission on your data, recorded with lineage — grants and
          revocations are ledger events, never edits.
        </p>
      </div>

      {!canWrite && (
        <p
          className="text-sm text-muted-foreground flex items-center gap-2"
          data-testid="text-consent-readonly"
        >
          <Info className="w-4 h-4" />
          Read-only view — granting or revoking consent is for the client's own
          account (or the firm admin).
        </p>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {LAYERS.map((l) => {
            const Icon = l.icon;
            const current = layerStatus(records ?? [], l.layer);
            const granted = current?.action === "grant";
            return (
              <Card key={l.layer} data-testid={`consent-layer-${l.layer}`}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    <span className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-primary" />
                      Layer {l.layer} · {l.title}
                    </span>
                    {l.dormant ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                        <Lock className="w-3 h-3" /> Not yet available
                      </span>
                    ) : granted ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-200">
                        <ShieldCheck className="w-3 h-3" /> Granted
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                        <ShieldOff className="w-3 h-3" /> Not granted
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{l.description}</p>
                  {current && (
                    <p className="text-xs text-muted-foreground">
                      Last change: {current.action} · {formatDate(current.createdAt)} via{" "}
                      {current.channel}
                    </p>
                  )}
                  {!l.dormant && canWrite && (
                    <div className="flex gap-2">
                      {granted ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          disabled={record.isPending}
                          onClick={() => act(l.layer, l.scope, "revoke")}
                          data-testid={`button-revoke-${l.layer}`}
                        >
                          <ShieldOff className="w-4 h-4 mr-1" /> Revoke
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={record.isPending}
                          onClick={() => act(l.layer, l.scope, "grant")}
                          data-testid={`button-grant-${l.layer}`}
                        >
                          <ShieldCheck className="w-4 h-4 mr-1" /> Grant
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Consent history</CardTitle>
        </CardHeader>
        <CardContent>
          {(records ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No consent events yet.</p>
          ) : (
            <div className="divide-y">
              {[...(records ?? [])]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((r) => (
                  <div key={r.id} className="py-2 text-sm flex items-center justify-between gap-3">
                    <span>
                      <span className={`font-medium ${r.action === "grant" ? "text-emerald-700" : "text-red-700"}`}>
                        {r.action}
                      </span>{" "}
                      layer {r.layer} · {r.scope}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDate(r.createdAt)} · {r.channel}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
