import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import {
  useGetClientPortfolio,
  useGetMe,
  useExportClientData,
  getExportClientDataQueryKey,
  useOffboardClient,
  getGetPortfolioQueryKey,
  useListCollectionAccounts,
  getListCollectionAccountsQueryKey,
  useGetUnmatchedCollections,
  getGetUnmatchedCollectionsQueryKey,
  useCreateCollectionAccount,
  useDeactivateCollectionAccount,
  getGetCompliancePackUrl,
  useNotifyCompliancePack,
  useListAdvisoryBriefs,
  getListAdvisoryBriefsQueryKey,
  useGenerateAdvisoryBrief,
} from "@workspace/api-client-react";
import type { OffboardClientResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import { ClerkActionEffectivenessCard } from "@/components/clerk-action-effectiveness-card";
import { FilingsCard } from "@/components/filings-card";
import { OnboardingCard } from "@/components/onboarding-card";
import { WhtCard } from "@/components/wht-card";
import { ObligationsCard } from "@/components/obligations-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { InvoiceStatusLight } from "@/components/status-light";
import {
  ArrowLeft,
  AlertTriangle,
  Archive,
  Download,
  Landmark,
  Send,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  severityBadgeClasses,
  humanize,
  pillClasses,
} from "@/lib/format";
import { localDayIso } from "@workspace/format/notice-copy";
import { downloadBlob, triggerDownload } from "@/lib/download";
import {
  errorStatus,
  serverErrorMessage,
  serverErrorToast,
} from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";

// ---- Export & offboarding helpers -------------------------------------------
// The data-subject export saves the server's bundle verbatim as JSON; the
// offboard flow is firm_admin-only with a typed-name confirm the SERVER
// verifies (the dialog only requires non-blank — the authority stays with
// the 400 CONFIRM_MISMATCH).

export function exportFilename(id: string): string {
  return `client-data-${id}.json`;
}

export function canOffboardClient(role: string | undefined): boolean {
  return role === "firm_admin";
}

/** The dialog's own gate: something typed. Exact matching is the server's. */
export function offboardConfirmReady(input: string): boolean {
  return input.trim().length > 0;
}

/** What offboarding does, in the words the confirm dialog shows. */
export const OFFBOARD_EXPLANATION =
  "Statutory invoice records are retained. The client's sign-in access is removed and this engagement is archived. Contact details are cleared when yours was their last engagement.";

/**
 * Inline note for a failed offboard. The endpoint's one 400 is the
 * CONFIRM_MISMATCH guard, so say that in words; anything else relays the
 * server's own message with a plain fallback.
 */
export function offboardErrorNote(err: unknown): string {
  if (errorStatus(err) === 400) {
    return "That doesn't match this client's legal name — type it exactly as shown.";
  }
  return serverErrorMessage(err) ?? "Could not offboard the client. Try again.";
}

/** Success-toast summary of what the offboard actually did. */
export function offboardSummary(result: OffboardClientResult): string {
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  const parts = [
    n(result.engagementsArchived, "engagement archived", "engagements archived"),
    n(result.membershipsRemoved, "sign-in removed", "sign-ins removed"),
  ];
  if (result.aliasesDeleted > 0) {
    parts.push(
      n(result.aliasesDeleted, "intake alias deleted", "intake aliases deleted"),
    );
  }
  parts.push(
    result.contactCleared
      ? "contact details cleared"
      : "contact details kept (still engaged elsewhere)",
  );
  return parts.join(" · ");
}

// ---- Compliance pack --------------------------------------------------------
// The monthly client pack is one server-rendered PDF; the console only picks
// the month, names the saved file, and (separately) asks the platform to
// tell the client it is ready — that notification is consent-gated and
// pointer-only server-side.

/** Saved-file name for the monthly pack PDF: "compliance-pack-YYYY-MM.pdf". */
export function packPdfFilename(monthStart: string): string {
  const month = monthStart.slice(0, 7);
  return month ? `compliance-pack-${month}.pdf` : "compliance-pack.pdf";
}

/**
 * The current month's first day (YYYY-MM-01) — the pack picker's default.
 * Deliberately BROWSER-local (a picker default, not a statutory clock);
 * the formatting kernel is the shared localDayIso.
 */
export function currentMonthStart(now: Date = new Date()): string {
  return `${localDayIso(now).slice(0, 7)}-01`;
}

function CompliancePackCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const [packMonth, setPackMonth] = useState(() => currentMonthStart());
  const notify = useNotifyCompliancePack();

  const handleNotify = () => {
    notify.mutate(
      { data: { clientPartyId, month: packMonth } },
      {
        onSuccess: () =>
          toast({
            title:
              "Client notified — delivery respects their consent and channel preferences.",
          }),
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not notify the client",
            fallback: "Try again.",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-compliance-pack">
      <CardHeader>
        <CardTitle className="text-base">Monthly compliance pack</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          One PDF for the month: cover note, document register, receivables,
          payables, VAT position and deadlines.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="pack-month">Month</Label>
          <Input
            id="pack-month"
            type="month"
            className="w-44"
            value={packMonth.slice(0, 7)}
            onChange={(e) =>
              setPackMonth(
                e.target.value ? `${e.target.value}-01` : currentMonthStart(),
              )
            }
            data-testid="input-pack-month"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              triggerDownload(
                getGetCompliancePackUrl({ clientPartyId, month: packMonth }),
                packPdfFilename(packMonth),
              )
            }
            data-testid="button-download-pack"
          >
            <Download className="w-4 h-4 mr-1" aria-hidden="true" /> Download
            pack (PDF)
          </Button>
          <Button
            variant="outline"
            onClick={handleNotify}
            disabled={notify.isPending}
            data-testid="button-notify-pack"
          >
            <Send className="w-4 h-4 mr-1" aria-hidden="true" />
            {notify.isPending ? "Notifying…" : "Notify client"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The notification is pointer-only — the client signs in to fetch the
          pack; none of their numbers ride the message.
        </p>
      </CardContent>
    </Card>
  );
}

// ---- Advisory brief (Advise with Clerk, round 49) ---------------------------
// The firm's monthly advisory work product for this client: deterministic
// evidence-cited sections composed from the platform's own reports, the
// adviser's note phrased at most once (template fallback). Generation is
// firm-side (engagement.write); regenerating within the month refreshes the
// same row.

function AdvisoryBriefCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: briefs, isSuccess } = useListAdvisoryBriefs(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListAdvisoryBriefsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  const generate = useGenerateAdvisoryBrief({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListAdvisoryBriefsQueryKey({ clientPartyId }),
        });
        toast({ title: "Advisory brief refreshed." });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not generate the brief",
          fallback: "Try again.",
        }),
    },
  });
  if (!isSuccess) return null;
  const brief = briefs?.[0];
  return (
    <Card data-testid="card-advisory-brief">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Advisory brief</CardTitle>
        <Button
          size="sm"
          onClick={() => generate.mutate({ data: { clientPartyId } })}
          disabled={generate.isPending}
          data-testid="button-generate-brief"
        >
          {generate.isPending
            ? "Generating…"
            : brief
              ? "Refresh brief"
              : "Generate brief"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The month's advisory position, composed from the client's own
          reports — statutory clocks, penalty exposure, VAT, money position
          and books hygiene. Every number cites the report it comes from;
          only the short adviser's note is phrased.
        </p>
        {!brief ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-brief-empty"
          >
            No brief yet for this client — generate the first one.
          </p>
        ) : (
          <div className="space-y-2" data-testid="advisory-brief-body">
            <p className="font-medium" data-testid="text-brief-headline">
              {brief.headline}
            </p>
            <p className="text-sm text-muted-foreground">{brief.note}</p>
            {brief.sections.map((section) => (
              <div
                key={section.key}
                className="border rounded-md p-3 space-y-1"
                data-testid={`brief-section-${section.key}`}
              >
                <p className="text-sm font-medium">{section.title}</p>
                <p className="text-sm">{section.text}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {section.facts.map((f) => (
                    <p key={f.key}>
                      {f.label}:{" "}
                      <span className="font-medium tabular-nums">
                        {f.value}
                        {f.unit ? ` ${f.unit}` : ""}
                      </span>
                    </p>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Source: {section.sourceReport}
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Covers{" "}
              {new Date(`${brief.monthStart.slice(0, 7)}-15`).toLocaleDateString(
                "en-NG",
                { month: "long", year: "numeric" },
              )}
              {brief.source === "clerk" && " · note written by Clerk"} · last
              refreshed {new Date(brief.updatedAt).toLocaleString()}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Collection accounts ----------------------------------------------------
// Virtual account references provisioned per client: payments sent to a
// reference are observed as settlement evidence automatically. Render-on-
// success — a 403 for roles without scope or a 404 from an older server
// build hides the card entirely.

function CollectionAccountsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = { clientPartyId };
  const query = useListCollectionAccounts(params, {
    query: {
      queryKey: getListCollectionAccountsQueryKey(params),
      retry: false,
    },
  });
  // Unmatched inbound payments (round 17): firm-wide report filtered to
  // THIS client's accounts — money arrived on a reference and bound to no
  // invoice. Render-on-success like the list itself.
  const { data: unmatched } = useGetUnmatchedCollections({
    query: { queryKey: getGetUnmatchedCollectionsQueryKey(), retry: false },
  });
  const unmatchedRows = (unmatched?.accounts ?? []).filter(
    (a) => a.clientPartyId === clientPartyId,
  );
  const create = useCreateCollectionAccount();
  const deactivate = useDeactivateCollectionAccount();
  if (!query.isSuccess) return null;
  const accounts = query.data ?? [];

  // Prefix key: every param variant of the list goes stale together.
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: getListCollectionAccountsQueryKey(),
    });

  const handleCreate = () => {
    create.mutate(
      { data: { clientPartyId } },
      {
        onSuccess: (account) => {
          refresh();
          toast({
            title: "Collection account provisioned",
            description: `Reference ${account.accountReference} now observes inbound payments as settlements.`,
          });
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not provision a collection account",
            fallback: "Try again.",
          }),
      },
    );
  };

  const handleDeactivate = (id: string) => {
    deactivate.mutate(
      { id },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Collection account deactivated",
            description:
              "Inbound payments on its reference stop being recorded.",
          });
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not deactivate the account",
            fallback: "Try again.",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-collection-accounts">
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="w-4 h-4" aria-hidden="true" /> Collection
          accounts
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreate}
          disabled={create.isPending}
          data-testid="button-create-collection-account"
        >
          {create.isPending ? "Provisioning…" : "Provision collection account"}
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-collection-accounts"
          >
            No collection accounts yet — provision one and payments sent to
            its reference are observed as settlements automatically.
          </p>
        ) : (
          <div className="divide-y">
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                data-testid={`row-collection-account-${a.id}`}
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs">{a.accountReference}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.label ?? humanize(a.provider)}
                  </p>
                </div>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={pillClasses(a.active ? "emerald" : "slate")}>
                    {a.active ? "Active" : "Inactive"}
                  </span>
                  {a.active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeactivate(a.id)}
                      disabled={deactivate.isPending}
                      data-testid={`button-deactivate-account-${a.id}`}
                    >
                      Deactivate
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {unmatchedRows.length > 0 && (
          <div
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
            data-testid="unmatched-collections-advisory"
          >
            {unmatchedRows.map((r) => (
              <p key={r.accountId} data-testid={`unmatched-${r.accountId}`}>
                {r.count} inbound payment{r.count === 1 ? "" : "s"} on{" "}
                <span className="font-mono text-xs">{r.accountReference}</span>{" "}
                (last {formatDate(r.lastSeen)}) matched no invoice — amounts
                are never recorded for unmatched payments; reconcile against
                the provider statement.
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ClientDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data, isLoading, error, refetch } = useGetClientPortfolio(id);
  usePageTitle(data?.client.legalName ?? "Client detail");

  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  // Data-subject export: the query sits armed but idle; the button fetches
  // once and saves the server's bundle verbatim.
  const exportQuery = useExportClientData(id, {
    query: {
      queryKey: getExportClientDataQueryKey(id),
      enabled: false,
      retry: false,
    },
  });
  const handleExport = async () => {
    const res = await exportQuery.refetch();
    if (res.error || !res.data) {
      toast({
        title: "Could not export the client's data",
        description: serverErrorMessage(res.error),
        variant: "destructive",
      });
      return;
    }
    downloadBlob(
      exportFilename(id),
      JSON.stringify(res.data, null, 2),
      "application/json",
    );
  };

  // Offboarding (firm_admin only): typed-name confirm, server-verified.
  const offboard = useOffboardClient();
  const [offboardOpen, setOffboardOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [offboardNote, setOffboardNote] = useState<string | null>(null);

  const openOffboard = () => {
    setConfirmText("");
    setOffboardNote(null);
    setOffboardOpen(true);
  };

  const handleOffboard = () => {
    setOffboardNote(null);
    offboard.mutate(
      { id, data: { confirmLegalName: confirmText.trim() } },
      {
        onSuccess: (result) => {
          toast({
            title: "Client offboarded",
            description: offboardSummary(result),
          });
          // The book changed — refresh the portfolio the navigation lands on.
          void queryClient.invalidateQueries({
            queryKey: getGetPortfolioQueryKey(),
          });
          navigate("/");
        },
        onError: (err) => setOffboardNote(offboardErrorNote(err)),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-40" />
        <div>
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-4 w-48 mt-2" />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          data-testid="link-back"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to portfolio
        </Link>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Client detail
        </h1>
        <QueryError thing="this client" onRetry={() => refetch()} />
      </div>
    );
  }

  const { client, invoices, deadlines } = data;
  const failingIds = new Set(client.failingInvoiceIds);

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to portfolio
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-client-name"
          >
            {client.legalName}
          </h1>
          <p className="text-muted-foreground mt-1">
            {client.totalInvoices} invoices · {humanize(client.penaltyRisk)}{" "}
            penalty risk
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={exportQuery.isFetching}
            data-testid="button-export-client-data"
          >
            <Download
              className={`w-4 h-4 mr-1 ${exportQuery.isFetching ? "animate-pulse" : ""}`}
              aria-hidden="true"
            />
            {exportQuery.isFetching ? "Exporting…" : "Export data"}
          </Button>
          {canOffboardClient(me?.role) && (
            <Button
              variant="destructive"
              onClick={openOffboard}
              data-testid="button-offboard-client"
            >
              <Archive className="w-4 h-4 mr-1" aria-hidden="true" />
              Offboard client
            </Button>
          )}
        </div>
        <span className="sr-only" aria-live="polite">
          {exportQuery.isFetching ? "Preparing the data export…" : ""}
        </span>
      </div>

      {client.failingInvoiceIds.length > 0 && (
        <Card className="border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="w-5 h-5 text-red-500 dark:text-red-400 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium text-red-800 dark:text-red-300">
                  {client.failingInvoiceIds.length} invoice
                  {client.failingInvoiceIds.length === 1 ? "" : "s"} need
                  attention
                </p>
                <p className="text-sm text-red-700 dark:text-red-400 mt-1">
                  Failed or overdue submissions are marked "Needs action" below.
                  The client resolves them in their MeridianIQ workspace;
                  escalated failures also land in the operator queue with a
                  playbook.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices yet.</p>
            ) : (
              <div className="divide-y">
                {invoices.map((inv) => {
                  const failing = inv.failing || failingIds.has(inv.id);
                  return (
                    <div
                      key={inv.id}
                      data-testid={`row-invoice-${inv.id}`}
                      className={`flex items-center gap-3 py-3 -mx-2 px-2 rounded-md ${
                        failing ? "bg-red-50 dark:bg-red-950/40" : ""
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {inv.invoiceNumber}
                          {failing && (
                            <span
                              className="ml-2 text-xs text-red-700 dark:text-red-400 font-semibold"
                              data-testid={`flag-failing-${inv.id}`}
                            >
                              NEEDS ACTION
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {inv.buyerName} · {inv.category} ·{" "}
                          {formatDate(inv.issueDate)}
                          <span className="sm:hidden tabular-nums">
                            {" "}
                            · {formatNaira(inv.grandTotal)}
                          </span>
                        </p>
                      </div>
                      <p className="text-sm font-medium hidden sm:block tabular-nums">
                        {formatNaira(inv.grandTotal)}
                      </p>
                      <span className={badgeClasses(inv.status)}>
                        {statusLabel(inv.status)}
                      </span>
                      <InvoiceStatusLight invoiceId={inv.id} />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deadlines</CardTitle>
          </CardHeader>
          <CardContent>
            {deadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No upcoming deadlines.
              </p>
            ) : (
              <div className="space-y-3">
                {deadlines.map((d) => (
                  <div
                    key={d.id}
                    data-testid={`row-deadline-${d.id}`}
                    className="border rounded-md p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm">{d.title}</p>
                      <span className={severityBadgeClasses(d.severity)}>
                        {humanize(d.status)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Due {formatDate(d.dueDate)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Payments rail + monthly deliverable for this client. Both are
            per-client operator surfaces; the collection-accounts card gates
            itself render-on-success. */}
        <CollectionAccountsCard clientPartyId={id} />
        <CompliancePackCard clientPartyId={id} />
        <AdvisoryBriefCard clientPartyId={id} />
        {/* Onboard with Clerk: the evidence-based onboarding checklist —
            steps settle from the record (history, statements, consent,
            duplicates, filings), skips record honest gaps. */}
        <OnboardingCard clientPartyId={id} />
        {/* Notice Desk: this client's tax-authority notices and their
            response deadlines — obligations from approved Clerk notice
            cases plus the inline paper-notice recorder. */}
        <ObligationsCard clientPartyId={id} />
        {/* Filing Desk: the register's other half — the calendar's returns
            (the VAT return and PAYE remittance each period owes), not the
            authority's notices; minted by sync and walked to filed here. */}
        <FilingsCard clientPartyId={id} />
        {/* WHT Desk: the withholding-credit ledger (deductions owed a
            credit note, walked to received here) plus the period's
            remittance schedule; renders only when the client has WHT
            activity. */}
        <WhtCard clientPartyId={id} />
        {/* Proposed actions (round 22): the firm-side approval surface —
            gates itself on the clerk_actions flag via its own query. */}
        <ClerkActionsCard clientPartyId={id} />
        {/* Round 29: did the approved batches work? Renders only when the
            window holds decisions. */}
        <ClerkActionEffectivenessCard clientPartyId={id} />
      </div>

      <Dialog
        open={offboardOpen}
        onOpenChange={(o) => {
          if (!o) setOffboardOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Offboard {client.legalName}?</DialogTitle>
            <DialogDescription>{OFFBOARD_EXPLANATION}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="offboard-confirm">
              Type the client's legal name to confirm
            </Label>
            <Input
              id="offboard-confirm"
              value={confirmText}
              autoComplete="off"
              placeholder={client.legalName}
              onChange={(e) => setConfirmText(e.target.value)}
              aria-invalid={offboardNote !== null}
              aria-describedby={
                offboardNote !== null ? "offboard-confirm-error" : undefined
              }
              data-testid="input-offboard-confirm"
            />
            {offboardNote && (
              <p
                id="offboard-confirm-error"
                className="text-sm text-destructive"
                role="alert"
                data-testid="text-offboard-error"
              >
                {offboardNote}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOffboardOpen(false)}
              disabled={offboard.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleOffboard}
              disabled={!offboardConfirmReady(confirmText) || offboard.isPending}
              data-testid="button-confirm-offboard"
            >
              {offboard.isPending ? "Offboarding…" : "Offboard client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
