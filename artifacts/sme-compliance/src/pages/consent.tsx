import { useState } from "react";
import { Link } from "wouter";
import {
  exportClientData,
  useGetMe,
  useListConsent,
  useRecordConsent,
  getListConsentQueryKey,
} from "@workspace/api-client-react";
import type { ConsentRecord } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Download,
  Landmark,
} from "lucide-react";
import { triggerDownload } from "@/lib/download";
import { serverErrorMessage } from "@/lib/errors";
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

// The consequence a client accepts when revoking each layer — shown in the
// confirm dialog before the ledger event is recorded. Layer 3 is dormant and
// never shows a revoke button.
const REVOKE_CONSEQUENCES: Record<number, string> = {
  1: "MeridianIQ stops validating, submitting and vaulting your invoices, and deadline alerts stop.",
  2: "Your data stops feeding anonymized industry benchmarks.",
};

// Save in-memory bytes as a named download — the console's downloadBlob idiom
// (console/src/lib/download.ts): wrap them in a Blob, click a temporary
// object-URL anchor via triggerDownload, then revoke the URL. Local to this
// page: SME's @/lib/download re-exports only the anchor helper.
function downloadBlob(filename: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

// A "not now" chosen on the first landing (D15) is recorded as a revoke event
// so the ledger stays two-valued, but it never followed a grant — read it as
// a decline, not a revocation.
function actionLabel(r: Pick<ConsentRecord, "action" | "channel">): string {
  if (r.action === "grant") return "Granted";
  return r.channel === "first_landing" ? "Declined" : "Revoked";
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
  // Revoking is a permanent ledger event that darkens dependent features, so
  // it must survive a misclick: the Revoke button only arms this dialog.
  const [revokeTarget, setRevokeTarget] = useState<
    (typeof LAYERS)[number] | null
  >(null);

  // Data-subject export (CORE-03 companion): fetched on demand — not a
  // mounted query — so nothing is pulled until the client asks for it.
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const downloadMyData = async () => {
    if (exporting || !clientPartyId) return;
    setExporting(true);
    setExportFailed(false);
    try {
      const bundle = await exportClientData(clientPartyId);
      downloadBlob(
        `client-data-${clientPartyId}.json`,
        JSON.stringify(bundle, null, 2),
        "application/json",
      );
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

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
            title: `Consent ${action === "grant" ? "granted" : "revoked"} — ${scopeTitle(scope)}`,
            description:
              action === "revoke"
                ? "Revocation takes effect immediately — dependent features stop within a minute."
                : undefined,
          });
          queryClient.invalidateQueries({
            queryKey: getListConsentQueryKey(clientPartyId),
          });
        },
        onError: (e) =>
          toast({
            title: "Could not record consent",
            description: serverErrorMessage(e),
            variant: "destructive",
          }),
        onSettled: () => setActingLayer(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consent"
        description={
          <>
            Every permission you've given us, with a full history — changes
            are always recorded, never overwritten.{" "}
            <Link
              href="/help#consent"
              className="font-bold text-teal-800 underline underline-offset-2"
              data-testid="link-help-consent"
            >
              How consent works
            </Link>
          </>
        }
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
                        <h2 className="flex items-center justify-between gap-2 text-base font-semibold leading-snug">
                          <span className="flex items-center gap-2">
                            <Icon className="w-4 h-4 text-primary" aria-hidden="true" />
                            {l.title}
                            <span className="text-xs font-normal text-muted-foreground">
                              Layer {l.layer}
                            </span>
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
                        </h2>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground">{l.description}</p>
                        {current && (
                          <p className="text-xs text-muted-foreground">
                            Last change: {actionLabel(current)} ·{" "}
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
                                onClick={() => setRevokeTarget(l)}
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
                  <h2 className="text-base font-semibold leading-snug">
                    Consent history
                  </h2>
                </CardHeader>
                <CardContent>
                  {(records ?? []).length === 0 ? (
                    <EmptyState
                      icon={ShieldCheck}
                      title="No consent events yet"
                      description="Every permission you grant or revoke appears here, with the date and how the change was made."
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
                                {actionLabel(r)}
                              </span>{" "}
                              · {scopeTitle(r.scope)} · Layer {r.layer}
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
              <AlertDialog
                open={revokeTarget !== null}
                onOpenChange={(open) => {
                  if (!open) setRevokeTarget(null);
                }}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Revoke {revokeTarget?.title ?? "this consent"}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {REVOKE_CONSEQUENCES[revokeTarget?.layer ?? 0] ?? ""} This
                      takes effect within a minute, and the revocation is
                      recorded permanently in your consent history.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep consent</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (revokeTarget) {
                          act(revokeTarget.layer, revokeTarget.scope, "revoke");
                        }
                        setRevokeTarget(null);
                      }}
                      data-testid="button-confirm-revoke"
                    >
                      Revoke consent
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold leading-snug">Your data</h2>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Download a complete copy of the data MeridianIQ holds about
                your business.
              </p>
              {exportFailed ? (
                <QueryError
                  thing="your data export"
                  onRetry={() => void downloadMyData()}
                />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={exporting}
                  onClick={() => void downloadMyData()}
                  data-testid="button-download-my-data"
                >
                  <Download className="w-4 h-4 mr-1" aria-hidden="true" />
                  {exporting ? "Preparing…" : "Download my data"}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </RequireClientScope>
    </div>
  );
}
