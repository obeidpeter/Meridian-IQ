import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  getGetFirmReceivablesQueryKey,
  getGetVatPackQueryKey,
  getGetRejectionPatternsQueryKey,
  useGetFirmReceivables,
  useGetMe,
  useGetPortfolio,
  useGetVatPack,
  useGetRejectionPatterns,
  useGetFirmComplianceCalendar,
  getGetFirmComplianceCalendarQueryKey,
  useGetClerkAdoptionReport,
  getGetClerkAdoptionReportQueryKey,
  useDraftVatPackCoverNote,
  type VatPackCoverNote,
  useGetVatSettlementCheck,
  useGetVatPosition,
  getGetVatPositionQueryKey,
  getGetVatSettlementCheckQueryKey,
  useGetFirmVatPositions,
  getGetFirmVatPositionsQueryKey,
  useGetQuarterlyReview,
  getGetQuarterlyReviewQueryKey,
  useDraftQuarterlyCoverNote,
  type QuarterlyReviewCoverNote,
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
  useListStatementConnections,
  getListStatementConnectionsQueryKey,
  useListInvitations,
  getListInvitationsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BillingStatementCard } from "@/components/billing-statement-card";
import { ClerkWeeklyDigestCard } from "@/components/clerk-digest-card";
import { GovernanceCard, isFirmAdminRole } from "@/components/governance-card";
import { VatPositionsCard } from "@/components/vat-positions-card";
import {
  StaffNotificationPrefsCard,
  isFirmMemberRole,
} from "@/components/staff-notification-prefs-card";
import { StatementConnectionsCard } from "@/components/statement-connections-card";
import { AddClientDialog } from "@/components/add-client-dialog";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import {
  AlertTriangle,
  Users,
  FileWarning,
  Clock,
  ChevronRight,
  CheckCircle2,
  Circle,
  Info,
  ListChecks,
  Plus,
  Upload,
  GitBranch,
  Download,
  Sparkles,
  Copy,
  TrendingUp,
  TrendingDown,
  Minus,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  formatNaira,
  formatDate,
  formatPct,
  riskBadgeClasses,
  riskLabel,
} from "@/lib/format";
import { usePageTitle } from "@/hooks/use-page-title";

// Receivables amounts arrive as decimal strings. NGN rows use the shared
// naira formatter; anything else gets a plain grouped number plus its
// currency code so a foreign-currency row never masquerades as naira.
const FOREIGN_AMOUNT_FORMAT = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(value: string, currency: string): string {
  if (currency === "NGN") return formatNaira(value);
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `${FOREIGN_AMOUNT_FORMAT.format(n)} ${currency}`;
}

// The portfolio's many cards, grouped for scanning. Grouping is layout only —
// every card keeps its own gating (render-on-success / role checks) and its
// testids. The anchor row under the header jumps to each group.
export const PORTFOLIO_GROUPS = [
  { id: "clients", label: "Clients" },
  { id: "money", label: "Money" },
  { id: "compliance", label: "Compliance" },
  { id: "connections", label: "Connections & delivery" },
] as const;

export type PortfolioGroup = (typeof PORTFOLIO_GROUPS)[number];

// ---- Section occupancy -------------------------------------------------------
// "clients" and "money" always carry an unconditionally rendered card, but
// "compliance" and "connections" are composed ENTIRELY of self-gating
// render-on-success cards — if every member gates itself to null (older
// server build, feature dark, wrong role), the section would be a bare
// heading with a dead anchor chip. The page therefore observes the SAME
// queries the cards gate on (identical query keys, so react-query dedupes to
// one fetch) and renders a section + its chip only once at least one member
// card will actually show.

/** Mirrors ComplianceCalendarCard's own empty gate. */
export function calendarHasContent<
  T extends { days: unknown[]; overdue: { invoices: number } },
>(calendar: T | undefined): calendar is T {
  return (
    !!calendar && (calendar.days.length > 0 || calendar.overdue.invoices > 0)
  );
}

/** Mirrors RejectionPatternsCard's own empty gate. */
export function rejectionsHaveContent<T extends { rows: unknown[] }>(
  report: T | undefined,
): report is T {
  return !!report && report.rows.length > 0;
}

/**
 * The groups whose sections (and anchor chips) render, in scanning order.
 * Clients and Money are always occupied; Compliance and Connections come
 * from the lifted occupancy flags.
 */
export function visiblePortfolioGroups(occupied: {
  compliance: boolean;
  connections: boolean;
}): PortfolioGroup[] {
  return PORTFOLIO_GROUPS.filter((g) =>
    g.id === "compliance"
      ? occupied.compliance
      : g.id === "connections"
        ? occupied.connections
        : true,
  );
}

// ---- Getting-started checklist -----------------------------------------------
// First-run guidance: five steps from an empty book to the first stamped
// invoice, computed from data the page already holds (portfolio counts +
// the invitations list). Consent (step 3) is deliberately an info row — the
// client grants it themselves and the portfolio payload cannot see it, so
// the card never pretends to know.

export const GETTING_STARTED_DISMISS_KEY = "console.gettingStarted.dismissed";

export type GettingStartedStep = {
  id: "add-client" | "invite-owner" | "consent" | "first-invoice" | "stamping";
  label: string;
  /** "step" rows carry a checkbox; "info" rows are explanatory only. */
  kind: "step" | "info";
  done: boolean;
};

/** Sum of the book's invoices — ClientRisk.totalInvoices per client. */
export function portfolioInvoiceCount(
  clients: ReadonlyArray<{ totalInvoices: number }>,
): number {
  return clients.reduce((sum, c) => sum + c.totalInvoices, 0);
}

/**
 * Invoices that reached the rails: stamped (accepted) plus pending (submitted,
 * awaiting the verdict) — the two portfolio fields that prove a submission
 * happened.
 */
export function portfolioSubmittedCount(
  clients: ReadonlyArray<{ stampedCount: number; pendingCount: number }>,
): number {
  return clients.reduce((sum, c) => sum + c.stampedCount + c.pendingCount, 0);
}

/** Step 2's predicate: any client_user invitation, whatever its status. */
export function hasClientOwnerInvite(
  invitations: ReadonlyArray<{ role: string }> | undefined,
): boolean {
  return (invitations ?? []).some((i) => i.role === "client_user");
}

export function gettingStartedSteps(input: {
  clientCount: number;
  hasClientInvite: boolean;
  invoiceCount: number;
  submittedCount: number;
}): GettingStartedStep[] {
  return [
    {
      id: "add-client",
      label: "Add your first client",
      kind: "step",
      done: input.clientCount > 0,
    },
    {
      id: "invite-owner",
      label: "Invite the client's owner",
      kind: "step",
      done: input.hasClientInvite,
    },
    { id: "consent", label: "Client grants consent", kind: "info", done: false },
    {
      id: "first-invoice",
      label: "Create the first invoice",
      kind: "step",
      done: input.invoiceCount > 0,
    },
    {
      id: "stamping",
      label: "Submit for stamping",
      kind: "step",
      done: input.submittedCount > 0,
    },
  ];
}

export function completedStepCount(steps: GettingStartedStep[]): number {
  return steps.filter((s) => s.kind === "step" && s.done).length;
}

/**
 * Show while the firm is still finding its feet: an empty book, or fewer
 * than 3 of the 4 checkable steps done — unless the partner dismissed it.
 */
export function shouldShowGettingStarted(args: {
  clientCount: number;
  steps: GettingStartedStep[];
  dismissed: boolean;
}): boolean {
  if (args.dismissed) return false;
  return args.clientCount === 0 || completedStepCount(args.steps) < 3;
}

// Storage access is parameterized so the helpers stay testable under node
// and a privacy mode that throws simply means "the card reappears".
export function readGettingStartedDismissed(
  storage: Pick<Storage, "getItem"> | null,
): boolean {
  try {
    return storage?.getItem(GETTING_STARTED_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGettingStartedDismissed(
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(GETTING_STARTED_DISMISS_KEY, "1");
  } catch {
    // Private mode — the dismissal simply doesn't stick.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function GettingStartedCard({
  steps,
  onAddClient,
  onDismiss,
}: {
  steps: GettingStartedStep[];
  onAddClient: () => void;
  onDismiss: () => void;
}) {
  const icon = (step: GettingStartedStep) =>
    step.kind === "info" ? (
      <Info
        className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    ) : step.done ? (
      <CheckCircle2
        className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    ) : (
      <Circle
        className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    );

  return (
    <Card
      className="rounded-lg border-teal-200 bg-teal-50/30 shadow-sm dark:border-teal-900 dark:bg-teal-950/20"
      data-testid="card-getting-started"
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-primary" aria-hidden="true" />
            Getting started
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            data-testid="button-dismiss-getting-started"
          >
            <X className="w-3.5 h-3.5 mr-1" aria-hidden="true" /> Dismiss
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ol className="space-y-1.5">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-start gap-2.5 text-sm"
              data-testid={`getting-started-${step.id}`}
            >
              {icon(step)}
              <div className="min-w-0">
                <span
                  className={
                    step.done ? "text-muted-foreground" : "font-medium"
                  }
                >
                  {step.kind === "step" && (
                    <span className="sr-only">
                      {step.done ? "Done — " : "To do — "}
                    </span>
                  )}
                  {step.label}
                </span>
                {step.id === "add-client" && !step.done && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 ml-2 text-sm"
                    onClick={onAddClient}
                    data-testid="button-checklist-add-client"
                  >
                    Add a client
                  </Button>
                )}
                {step.id === "invite-owner" && !step.done && (
                  <Link
                    href="/invitations"
                    className="ml-2 text-primary hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid="link-checklist-invitations"
                  >
                    Send an invite
                  </Link>
                )}
                {step.id === "consent" && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — the client signs in and grants Layer 1 sharing consent
                    from their own workspace (manual anchor: #consent). Not
                    tracked here.
                  </span>
                )}
                {step.id === "first-invoice" && !step.done && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — raised by the client, or drafted by Clerk from their
                    documents.
                  </span>
                )}
                {step.id === "stamping" && !step.done && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — done once any invoice is pending or stamped on the rails.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// A labeled group of cards. scroll-mt keeps an anchor-jumped heading clear of
// the sticky console header.
function PortfolioSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className="scroll-mt-24 space-y-4"
      data-testid={`portfolio-section-${id}`}
    >
      <h2 className="border-b border-slate-200 pb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-teal-700 dark:border-slate-800">
        {label}
      </h2>
      {children}
    </section>
  );
}

function PortfolioAnchorRow({ groups }: { groups: PortfolioGroup[] }) {
  return (
    <nav
      aria-label="Portfolio sections"
      className="flex flex-wrap gap-2"
      data-testid="portfolio-anchor-row"
    >
      {groups.map((g) => (
        <a
          key={g.id}
          href={`#${g.id}`}
          className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-slate-800 dark:bg-card dark:text-muted-foreground dark:hover:text-foreground"
          data-testid={`anchor-${g.id}`}
        >
          {g.label}
        </a>
      ))}
    </nav>
  );
}

// "2026-06-01" -> "June 2026" for the VAT pack month picker.
const PACK_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
function packMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${PACK_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// Both cover-note drafts land the same way: keep the response for the
// caption, seed the editable text, toast on failure.
function coverNoteHandlers<T extends { note: string }>(
  setNote: (note: T) => void,
  setNoteText: (text: string) => void,
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onSuccess: (res: T) => {
      setNote(res);
      setNoteText(res.note);
    },
    onError: () =>
      toast({ title: "Could not draft the note", variant: "destructive" }),
  };
}

// The drafted cover-note panel the VAT pack and quarterly review cards share:
// a source-dependent caption, the editable text, a clipboard Copy button and
// Discard. Each card passes its own testids so the DOM stays byte-identical.
function CoverNotePanel({
  periodLabel,
  source,
  destinationWord,
  text,
  onChange,
  onDiscard,
  testIds,
}: {
  periodLabel: string;
  source: string;
  destinationWord: string;
  text: string;
  onChange: (text: string) => void;
  onDiscard: () => void;
  testIds: { panel: string; input: string; copy: string; discard: string };
}) {
  const { toast } = useToast();
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid={testIds.panel}>
      <p className="text-xs font-medium text-muted-foreground">
        Cover note for {periodLabel} —{" "}
        {source === "clerk"
          ? "Clerk phrased the pack's own numbers; edit before sending."
          : "template text (Clerk unavailable); edit before sending."}{" "}
        Nothing is stored — copy it into your {destinationWord}.
      </p>
      <Textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[110px] text-sm"
        data-testid={testIds.input}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast({ title: "Copied" });
            } catch {
              toast({
                title: "Could not copy",
                description: "Select the text and copy it manually.",
                variant: "destructive",
              });
            }
          }}
          data-testid={testIds.copy}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDiscard}
          data-testid={testIds.discard}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

// Monthly VAT filing pack (exhaust idea #2): per-client output VAT for a
// closed Lagos month, deterministic end to end — the numbers mirror the
// per-client statements. Renders only on success (a 403 for roles without
// the portfolio capability simply hides the card).
function VatPackCard() {
  const { toast } = useToast();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: pack, isSuccess } = useGetVatPack(params, {
    query: { queryKey: getGetVatPackQueryKey(params), retry: false },
  });

  // Cover note (round-4 idea #6): phrases the pack's own numbers; the
  // partner edits and owns the text — nothing is stored server-side.
  const coverNote = useDraftVatPackCoverNote();
  const [note, setNote] = useState<VatPackCoverNote | null>(null);
  const [noteText, setNoteText] = useState("");
  const draftNote = (monthStart: string) => {
    coverNote.mutate(
      { data: { month: monthStart } },
      coverNoteHandlers<VatPackCoverNote>(setNote, setNoteText, toast),
    );
  };

  if (!isSuccess || !pack) return null;
  const exportHref = `/api/vat-pack/export?month=${encodeURIComponent(pack.monthStart)}`;
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-vat-pack"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>VAT filing pack</span>
          <span className="flex items-center gap-2">
            <Select
              value={pack.monthStart}
              onValueChange={(m) => {
                setMonth(m);
                setNote(null);
              }}
            >
              <SelectTrigger
                className="h-8 w-44 text-xs"
                data-testid="select-vat-pack-month"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pack.months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {packMonthLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.assign(exportHref)}
              data-testid="button-vat-pack-csv"
            >
              <Download className="w-4 h-4 mr-1" aria-hidden="true" /> CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={coverNote.isPending}
              onClick={() => draftNote(pack.monthStart)}
              data-testid="button-vat-cover-note"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {coverNote.isPending ? "Drafting…" : "Cover note"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pack.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-vat-pack-empty">
            No invoices were accepted by the rails in {pack.monthLabel}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-vat-pack">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium text-right">Accepted</th>
                  <th className="py-2 pr-3 font-medium text-right">Total</th>
                  <th className="py-2 pr-3 font-medium text-right">Output VAT</th>
                  <th className="py-2 pr-3 font-medium text-right">Credits</th>
                  <th className="py-2 font-medium text-right">Net VAT</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pack.rows.map((r) => (
                  <tr key={r.clientPartyId} data-testid={`row-vat-${r.clientPartyId}`}>
                    <td className="py-2 pr-3">{r.clientName}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.acceptedCount}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.acceptedTotal)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.acceptedVat)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.creditCount > 0 ? `−${formatNaira(r.creditVat)}` : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatNaira(r.netVat)}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pack.totals.acceptedCount}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(pack.totals.acceptedTotal)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(pack.totals.acceptedVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pack.totals.creditCount > 0
                      ? `−${formatNaira(pack.totals.creditVat)}`
                      : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatNaira(pack.totals.netVat)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{pack.note}</p>
        {note && (
          <CoverNotePanel
            periodLabel={note.monthLabel}
            source={note.source}
            destinationWord="email"
            text={noteText}
            onChange={setNoteText}
            onDiscard={() => setNote(null)}
            testIds={{
              panel: "vat-cover-note",
              input: "input-vat-cover-note",
              copy: "button-copy-cover-note",
              discard: "button-discard-cover-note",
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// VAT settlement cross-check (round-13 idea #6): how much of the pack
// month's accepted value the platform has OBSERVED settling. Deliberately an
// assurance view — the server's note says "unobserved, not unpaid" and it
// renders with every state.
// Net VAT position (round-15 idea #1): output VAT from the pack minus
// VERIFIED input VAT on the month's supplier bills — the filing number,
// with the unverified list as the recovery CTA.
function VatPositionCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: position, isSuccess } = useGetVatPosition(params, {
    query: { queryKey: getGetVatPositionQueryKey(params), retry: false },
  });
  if (!isSuccess || !position) return null;
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-vat-position"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Net VAT position — {position.monthLabel}</span>
          <Select value={position.monthStart} onValueChange={(m) => setMonth(m)}>
            <SelectTrigger
              className="h-8 w-44 text-xs"
              data-testid="select-vat-position-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {position.months.map((m) => (
                <SelectItem key={m} value={m}>
                  {packMonthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Output VAT (net)"
            value={formatNaira(position.outputNetVat)}
            testId="tile-vat-output"
          />
          <StatTile
            label="Verified input VAT"
            value={formatNaira(position.verifiedVat)}
            detail={`${position.verifiedCount} of ${position.billCount} bills`}
            testId="tile-vat-input"
          />
          <StatTile
            label="Net position"
            value={formatNaira(position.netPosition)}
            testId="tile-vat-net"
          />
          <StatTile
            label="Unverified input VAT"
            value={formatNaira(position.unverifiedVat)}
            detail={`${position.unverifiedCount} bill(s) to verify`}
            tone={position.unverifiedCount > 0 ? "warning" : undefined}
            testId="tile-vat-unverified"
          />
        </div>
        {position.unverified.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-vat-unverified-bills">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Bill</th>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium">Supplier</th>
                  <th className="py-2 font-medium text-right">Input VAT</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {position.unverified.map((r) => (
                  <tr key={r.invoiceId}>
                    <td className="py-2 pr-3">{r.invoiceNumber}</td>
                    <td className="py-2 pr-3">{r.clientName}</td>
                    <td className="py-2 pr-3">{r.supplierName}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(r.vatTotal, r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {position.unverifiedTruncated && (
              <p className="pt-1 text-xs text-muted-foreground">
                Showing the largest {position.unverified.length} — more exist.
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{position.note}</p>
      </CardContent>
    </Card>
  );
}

function VatSettlementCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: check, isSuccess } = useGetVatSettlementCheck(params, {
    query: { queryKey: getGetVatSettlementCheckQueryKey(params), retry: false },
  });
  if (!isSuccess || !check) return null;
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-vat-settlement"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Settlement cross-check — {check.monthLabel}</span>
          <Select value={check.monthStart} onValueChange={(m) => setMonth(m)}>
            <SelectTrigger
              className="h-8 w-44 text-xs"
              data-testid="select-vat-settlement-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {check.months.map((m) => (
                <SelectItem key={m} value={m}>
                  {packMonthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {check.acceptedCount === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-vat-settlement-empty"
          >
            No invoices were accepted by the rails in {check.monthLabel}.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Accepted"
                value={`${check.acceptedCount}`}
                detail={formatNaira(check.acceptedTotal)}
                testId="tile-settlement-accepted"
              />
              <StatTile
                label="Settlement observed"
                value={
                  check.settledShare != null ? formatPct(check.settledShare) : "—"
                }
                detail={`${check.settledCount} · ${formatNaira(check.settledTotal)}`}
                testId="tile-settlement-observed"
              />
              <StatTile
                label="Not yet observed"
                value={`${check.outstandingCount}`}
                detail={formatNaira(check.outstandingTotal)}
                testId="tile-settlement-outstanding"
              />
              <StatTile
                label="Since credited"
                value={`${check.creditedCount}`}
                detail={formatNaira(check.creditedTotal)}
                testId="tile-settlement-credited"
              />
            </div>
            {check.unsettled.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-vat-unsettled">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Invoice</th>
                      <th className="py-2 pr-3 font-medium">Client</th>
                      <th className="py-2 pr-3 font-medium">Buyer</th>
                      <th className="py-2 pr-3 font-medium">Due</th>
                      <th className="py-2 font-medium text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {check.unsettled.map((r) => (
                      <tr key={r.invoiceId} data-testid={`row-unsettled-${r.invoiceId}`}>
                        <td className="py-2 pr-3">{r.invoiceNumber}</td>
                        <td className="py-2 pr-3">{r.clientName}</td>
                        <td className="py-2 pr-3">{r.buyerName}</td>
                        <td className="py-2 pr-3">{formatDate(r.dueDate)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMoney(r.grandTotal, r.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {check.unsettledTruncated && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    Showing the largest {check.unsettled.length} — more exist.
                  </p>
                )}
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">{check.note}</p>
      </CardContent>
    </Card>
  );
}

// Quarterly review pack (round-13 idea #4): the closed quarter's monthly VAT
// packs, submission outcomes, rejection causes, receivables snapshot and
// Clerk throughput — one deterministic document for the quarterly client-book
// conversation, with an optional phrased cover note (digest posture).
function QuarterlyReviewCard() {
  const { toast } = useToast();
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const params = quarter ? { quarter } : undefined;
  const { data: review, isSuccess } = useGetQuarterlyReview(params, {
    query: { queryKey: getGetQuarterlyReviewQueryKey(params), retry: false },
  });

  const coverNote = useDraftQuarterlyCoverNote();
  const [note, setNote] = useState<QuarterlyReviewCoverNote | null>(null);
  const [noteText, setNoteText] = useState("");

  if (!isSuccess || !review) return null;
  const quarterShort = (q: string) => {
    const [y, m] = q.split("-");
    return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`;
  };
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-quarterly-review"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Quarterly review — {review.quarterLabel}</span>
          <span className="flex items-center gap-2">
            <Select
              value={review.quarterStart}
              onValueChange={(q) => {
                setQuarter(q);
                setNote(null);
              }}
            >
              <SelectTrigger
                className="h-8 w-28 text-xs"
                data-testid="select-quarterly-quarter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {review.quarters.map((q) => (
                  <SelectItem key={q} value={q}>
                    {quarterShort(q)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={coverNote.isPending}
              onClick={() =>
                coverNote.mutate(
                  { data: { quarter: review.quarterStart } },
                  coverNoteHandlers<QuarterlyReviewCoverNote>(
                    setNote,
                    setNoteText,
                    toast,
                  ),
                )
              }
              data-testid="button-quarterly-cover-note"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {coverNote.isPending ? "Drafting…" : "Cover note"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-quarterly-months">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Month</th>
                <th className="py-2 pr-3 font-medium text-right">Accepted</th>
                <th className="py-2 pr-3 font-medium text-right">Output VAT</th>
                <th className="py-2 pr-3 font-medium text-right">Credits</th>
                <th className="py-2 font-medium text-right">Net VAT</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {review.months.map((m) => (
                <tr key={m.monthStart}>
                  <td className="py-2 pr-3">{m.monthLabel}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {m.acceptedCount}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(m.acceptedVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {Number(m.creditVat) > 0 ? `−${formatNaira(m.creditVat)}` : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatNaira(m.netVat)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-3">Quarter</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {review.vatTotals.acceptedCount}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatNaira(review.vatTotals.acceptedVat)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {Number(review.vatTotals.creditVat) > 0
                    ? `−${formatNaira(review.vatTotals.creditVat)}`
                    : "—"}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatNaira(review.vatTotals.netVat)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Submissions accepted"
            value={`${review.submissions.accepted}`}
            testId="tile-quarterly-accepted"
          />
          <StatTile
            label="Rejected"
            value={`${review.rejectionTotal}`}
            detail={
              review.topRejections.length > 0
                ? review.topRejections
                    .slice(0, 2)
                    .map((r) => `${r.errorCode} ×${r.count}`)
                    .join(" · ")
                : undefined
            }
            testId="tile-quarterly-rejected"
          />
          <StatTile
            label="Receivables today"
            value={
              review.receivables.groups.length > 0
                ? formatMoney(
                    review.receivables.groups[0].outstandingTotal,
                    review.receivables.groups[0].currency,
                  )
                : "—"
            }
            detail={
              review.receivables.groups.length > 1
                ? `+ ${review.receivables.groups.length - 1} more currenc${review.receivables.groups.length > 2 ? "ies" : "y"}`
                : undefined
            }
            testId="tile-quarterly-receivables"
          />
          <StatTile
            label="Clerk captures"
            value={`${review.clerk.captures}`}
            detail={`${review.clerk.approved} approved`}
            testId="tile-quarterly-clerk"
          />
        </div>
        <p className="text-xs text-muted-foreground">{review.note}</p>
        {note && (
          <CoverNotePanel
            periodLabel={note.quarterLabel}
            source={note.source}
            destinationWord="letter"
            text={noteText}
            onChange={setNoteText}
            onDiscard={() => setNote(null)}
            testIds={{
              panel: "quarterly-cover-note",
              input: "input-quarterly-cover-note",
              copy: "button-copy-quarterly-note",
              discard: "button-discard-quarterly-note",
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// Firm-level compliance calendar (round-6 idea #5): the month-ahead view of
// the same statutory clocks each client's dashboard shows — same constants,
// same Lagos-calendar predicates server-side, so this card can never
// disagree with what a client sees.
function ComplianceCalendarCard() {
  const { data: calendar, isSuccess } = useGetFirmComplianceCalendar({
    query: { queryKey: getGetFirmComplianceCalendarQueryKey(), retry: false },
  });
  // Same predicate the page's section-occupancy check uses, so the card and
  // the section can never disagree about a quiet calendar.
  if (!isSuccess || !calendarHasContent(calendar)) return null;
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-compliance-calendar"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-4 h-4 text-primary" aria-hidden="true" />
          Compliance calendar — next {calendar.horizonDays} days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {calendar.overdue.invoices > 0 && (
          <div
            className="rounded-md border border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40 px-3 py-2 text-sm text-red-900 dark:text-red-200"
            data-testid="calendar-overdue"
          >
            {calendar.overdue.invoices} unsubmitted invoice(s) across{" "}
            {calendar.overdue.clients} client(s) are already past their
            submission window.
          </div>
        )}
        {calendar.days.map((day) => (
          <div
            key={day.date}
            className="flex items-start gap-3 text-sm border-b last:border-b-0 pb-2 last:pb-0"
            data-testid={`calendar-day-${day.date}`}
          >
            <span className="font-medium tabular-nums shrink-0 w-28">
              {formatDate(day.date)}
            </span>
            <div className="min-w-0 space-y-0.5">
              {day.events.map((e, i) => (
                <p
                  key={i}
                  className={
                    e.kind === "vat_return"
                      ? "font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {e.label}
                </p>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Same statutory clocks as each client's dashboard (Lagos calendar) —
          submission windows and VAT filing dates, computed live. No AI
          involved.
        </p>
      </CardContent>
    </Card>
  );
}

// Clerk adoption & impact (round-10 idea #3): per-client capture volume,
// kept-rate and review turnaround — the "is Clerk working for us" numbers.
// Renders only when clients have approved captures in the window.
function ClerkAdoptionCard() {
  const { data: report, isSuccess } = useGetClerkAdoptionReport({
    query: { queryKey: getGetClerkAdoptionReportQueryKey(), retry: false },
  });
  if (!isSuccess || !report || report.clients.length === 0) return null;
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-clerk-adoption"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
          Clerk adoption &amp; impact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Last {report.windowDays} days: {report.totals.extractionCases}{" "}
          documents read, {report.totals.approvedCases} approved into invoices
          ({formatPct(report.totals.approvedShare)});{" "}
          {formatPct(report.totals.keptRate)} of extracted fields kept
          unchanged. Computed from your own cases — no AI involved.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-clerk-adoption">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Client</th>
                <th className="py-2 pr-3 font-medium text-right">Approved</th>
                <th className="py-2 pr-3 font-medium text-right">Kept</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Review time
                </th>
                <th className="py-2 font-medium text-right">Last approved</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.clients.slice(0, 8).map((c) => (
                <tr
                  key={c.clientPartyId}
                  data-testid={`row-adoption-${c.clientPartyId}`}
                >
                  <td className="py-2 pr-3 max-w-[16rem] truncate">
                    {c.clientName}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.approvedCases}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.fieldsCompared === 0 ? "—" : formatPct(c.keptRate)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.avgReviewMinutes == null
                      ? "—"
                      : `${c.avgReviewMinutes}m`}
                  </td>
                  <td className="py-2 text-right text-xs text-muted-foreground">
                    {formatDate(c.lastApprovedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// Rejection-pattern report (round-4 idea #3): the firm's recurring rejection
// causes, catalogue-grounded, with a prior-window trend. Renders only on
// success and only when there is something to show — a quiet firm sees no
// card, not an empty table.
function RejectionPatternsCard() {
  const { data: report, isSuccess } = useGetRejectionPatterns({
    query: { queryKey: getGetRejectionPatternsQueryKey(), retry: false },
  });
  // Same predicate the page's section-occupancy check uses, so the card and
  // the section can never disagree about a quiet firm.
  if (!isSuccess || !rejectionsHaveContent(report)) return null;
  const trend = (count: number, previous: number) =>
    count > previous ? (
      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
        <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
        {count - previous > 0 ? `+${count - previous}` : ""}
      </span>
    ) : count < previous ? (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />−
        {previous - count}
      </span>
    ) : (
      <Minus className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
    );
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-rejection-patterns"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileWarning className="w-4 h-4 text-primary" aria-hidden="true" />
          Recurring rejection causes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-rejection-patterns">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Last {report.windowDays}d
                </th>
                <th className="py-2 pr-3 font-medium text-right">Trend</th>
                <th className="py-2 pr-3 font-medium text-right">Clients</th>
                <th className="py-2 font-medium">Fix</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.rows.slice(0, 8).map((r) => (
                <tr key={r.errorCode} data-testid={`row-rejection-${r.errorCode}`}>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs">{r.errorCode}</span>
                    {r.category && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {r.category}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.count}</td>
                  <td className="py-2 pr-3 text-right">
                    {trend(r.count, r.previousCount)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.clientCount}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground max-w-[22rem]">
                    {r.fix ?? "Not in the catalogue yet — draft an entry from the catalogue page."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Rejected submission attempts in the last {report.windowDays} days (
          {report.totalRejections}) against the {report.windowDays} before (
          {report.previousTotal}). Computed from your own submission history —
          no AI involved.
        </p>
      </CardContent>
    </Card>
  );
}

// Firm-level receivables: one row per client per currency, worst-first from
// the API. Loads independently of the portfolio query so a failure here
// never blanks the risk view above it.
function ReceivablesCard() {
  const { data, isLoading, error, refetch } = useGetFirmReceivables({
    query: { queryKey: getGetFirmReceivablesQueryKey() },
  });

  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-receivables"
    >
      <CardHeader>
        <CardTitle className="text-base">Receivables</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : error || !data ? (
          <QueryError thing="receivables" onRetry={() => refetch()} />
        ) : data.clients.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables across the book.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      Client
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Outstanding
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Invoices
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      90+ days
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Oldest due
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr
                      key={`${c.clientPartyId}-${c.currency}`}
                      className="border-b last:border-0"
                      data-testid={`row-receivable-${c.clientPartyId}-${c.currency}`}
                    >
                      <td className="py-2.5 font-medium">
                        <Link
                          href={`/clients/${c.clientPartyId}`}
                          className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {c.clientName}
                        </Link>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatMoney(c.outstandingTotal, c.currency)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {c.invoiceCount}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {Number(c.overdue90Amount) > 0 ? (
                          <span className="font-medium text-red-500 dark:text-red-400">
                            {formatMoney(c.overdue90Amount, c.currency)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground tabular-nums">
                        {formatDate(c.oldestDueDate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.topDebtors.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  Top debtors
                </h3>
                <div className="divide-y">
                  {data.topDebtors.map((d) => (
                    <div
                      key={`${d.buyerPartyId}-${d.currency}`}
                      className="flex items-center justify-between gap-4 py-2"
                      data-testid={`row-debtor-${d.buyerPartyId}-${d.currency}`}
                    >
                      <p className="text-sm font-medium truncate">
                        {d.buyerName}
                      </p>
                      <p className="text-sm text-muted-foreground shrink-0 tabular-nums">
                        {formatMoney(d.outstanding, d.currency)} ·{" "}
                        {d.invoiceCount} invoice
                        {d.invoiceCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Mirrors the loaded page: header, four stat tiles, then a card of rows.
// Also used by App.tsx while /me resolves so the front door never goes blank.
export function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function PortfolioHeader({
  description,
  canImport,
  onAddClient,
}: {
  description: string;
  canImport: boolean;
  onAddClient: () => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-5 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <p className="text-[11px] font-extrabold uppercase text-teal-700">
          Firm overview
        </p>
        <h1
          className="mt-2 text-2xl font-extrabold text-slate-950 md:text-3xl dark:text-foreground"
          data-testid="text-page-title"
        >
          Client portfolio
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" asChild>
          <Link href="/pipeline">
            <GitBranch className="size-4" aria-hidden="true" />
            Onboarding
          </Link>
        </Button>
        <Button
          variant="outline"
          onClick={onAddClient}
          data-testid="button-add-client"
        >
          <Plus className="size-4" aria-hidden="true" />
          Add client
        </Button>
        {canImport && (
          <Button asChild>
            <Link href="/clients/import">
              <Upload className="size-4" aria-hidden="true" />
              Import clients
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function Portfolio() {
  usePageTitle("Client portfolio");
  const { data: me } = useGetMe();
  const { data, isLoading, error, refetch } = useGetPortfolio();
  const canImport = (me?.capabilities ?? []).includes("clients.import");

  // Getting-started checklist state: single-client intake dialog + the
  // localStorage-backed dismissal.
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [gettingStartedDismissed, setGettingStartedDismissed] = useState(() =>
    readGettingStartedDismissed(browserStorage()),
  );
  // Step 2's evidence. Fetched only while the checklist could still show —
  // a dismissed card costs nothing.
  const { data: invitations } = useListInvitations({
    query: {
      queryKey: getListInvitationsQueryKey(),
      retry: false,
      enabled: !gettingStartedDismissed && !!data,
    },
  });

  // Section occupancy: observe the SAME queries the section's self-gating
  // cards gate on — identical query keys, so react-query dedupes each to a
  // single fetch shared with the card once it mounts. Enabled only once the
  // book has clients, mirroring when the sections themselves can render.
  const hasBook = !!data && data.clients.length > 0;
  const gateVatPack = useGetVatPack(undefined, {
    query: {
      queryKey: getGetVatPackQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateSettlement = useGetVatSettlementCheck(undefined, {
    query: {
      queryKey: getGetVatSettlementCheckQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateVatPositions = useGetFirmVatPositions(undefined, {
    query: {
      queryKey: getGetFirmVatPositionsQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateQuarterly = useGetQuarterlyReview(undefined, {
    query: {
      queryKey: getGetQuarterlyReviewQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateCalendar = useGetFirmComplianceCalendar({
    query: {
      queryKey: getGetFirmComplianceCalendarQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateRejections = useGetRejectionPatterns({
    query: {
      queryKey: getGetRejectionPatternsQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateConnections = useListStatementConnections({
    query: {
      queryKey: getListStatementConnectionsQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateDigest = useGetClerkDigest({
    query: {
      queryKey: getGetClerkDigestQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const complianceOccupied =
    (gateCalendar.isSuccess && calendarHasContent(gateCalendar.data)) ||
    gateVatPack.isSuccess ||
    gateSettlement.isSuccess ||
    gateVatPositions.isSuccess ||
    gateQuarterly.isSuccess ||
    (gateRejections.isSuccess && rejectionsHaveContent(gateRejections.data)) ||
    // The governance card renders for firm admins (including its inline
    // error state), and only for them — mirror its role self-gate.
    isFirmAdminRole(me?.role);
  const connectionsOccupied =
    gateConnections.isSuccess ||
    gateDigest.isSuccess ||
    // The staff-prefs card renders for firm members (including its inline
    // error state), and only for them — mirror its role gate.
    isFirmMemberRole(me?.role);
  const groups = visiblePortfolioGroups({
    compliance: complianceOccupied,
    connections: connectionsOccupied,
  });

  // Checklist inputs, computed from data already on the page (portfolio
  // counts + the invitations list above).
  const steps = gettingStartedSteps({
    clientCount: data?.clients.length ?? 0,
    hasClientInvite: hasClientOwnerInvite(invitations),
    invoiceCount: portfolioInvoiceCount(data?.clients ?? []),
    submittedCount: portfolioSubmittedCount(data?.clients ?? []),
  });
  const showGettingStarted =
    !!data &&
    shouldShowGettingStarted({
      clientCount: data.clients.length,
      steps,
      dismissed: gettingStartedDismissed,
    });
  const handleDismissGettingStarted = () => {
    writeGettingStartedDismissed(browserStorage());
    setGettingStartedDismissed(true);
  };
  const openAddClient = () => setAddClientOpen(true);
  const addClientDialog = (
    <AddClientDialog open={addClientOpen} onOpenChange={setAddClientOpen} />
  );

  if (isLoading) {
    return <PortfolioSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Penalty exposure, filing deadlines and receivables across your client book."
          canImport={canImport}
          onAddClient={openAddClient}
        />
        <QueryError thing="your portfolio" onRetry={() => refetch()} />
        {addClientDialog}
      </div>
    );
  }

  const clients = [...data.clients].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.penaltyRisk] - order[b.penaltyRisk];
  });

  // First-run empty state: the query succeeded but the book is empty — show
  // the way in (bulk import / pipeline) instead of a wall of zeros.
  if (clients.length === 0) {
    return (
      <div className="space-y-6">
        <PortfolioHeader
          description="Set up the client book to start tracking risk, deadlines and receivables."
          canImport={canImport}
          onAddClient={openAddClient}
        />
        {showGettingStarted && (
          <GettingStartedCard
            steps={steps}
            onAddClient={openAddClient}
            onDismiss={handleDismissGettingStarted}
          />
        )}
        <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon={Users}
            title="Import your client book"
            description={
              <span className="block max-w-md">
                Clients appear here once they're on the platform. Bring your
                book across from a practice-management export, or track
                prospects through onboarding.
              </span>
            }
          >
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {canImport && (
                <Button asChild data-testid="button-empty-import">
                  <Link href="/clients/import">
                    <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                    Bulk import clients
                  </Link>
                </Button>
              )}
              <Button
                variant="outline"
                asChild
                data-testid="button-empty-pipeline"
              >
                <Link href="/pipeline">Open the onboarding pipeline</Link>
              </Button>
            </div>
          </EmptyState>
        </Card>
        {addClientDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortfolioHeader
        description={`Penalty risk, deadlines and receivables across ${data.clientCount} client${
          data.clientCount === 1 ? "" : "s"
        }.`}
        canImport={canImport}
        onAddClient={openAddClient}
      />

      {showGettingStarted && (
        <GettingStartedCard
          steps={steps}
          onAddClient={openAddClient}
          onDismiss={handleDismissGettingStarted}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Clients"
          value={String(data.clientCount)}
          icon={Users}
          testId="stat-clients"
        />
        <StatTile
          label="High-risk clients"
          value={String(data.highRiskCount)}
          icon={AlertTriangle}
          iconTone="danger"
          testId="stat-high-risk"
        />
        <StatTile
          label="Unsubmitted invoices"
          value={String(data.totalUnsubmittedCount)}
          detail={`${formatNaira(data.totalUnsubmittedValue)} awaiting submission`}
          icon={FileWarning}
          iconTone="warning"
          testId="stat-unsubmitted"
        />
        <StatTile
          label="Overdue deadlines"
          value={String(data.totalOverdueCount)}
          icon={Clock}
          iconTone="danger"
          testId="stat-overdue"
        />
      </div>

      <PortfolioAnchorRow groups={groups} />

      <PortfolioSection id="clients" label="Clients">
      <Card className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-4 text-base">
            <span>Clients by penalty risk</span>
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">
              {data.clientCount} total
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <div className="divide-y">
            {clients.map((c) => (
              <Link
                key={c.clientPartyId}
                href={`/clients/${c.clientPartyId}`}
                data-testid={`row-client-${c.clientPartyId}`}
                className="-mx-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_1rem] sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900 dark:text-foreground">
                    {c.legalName}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {c.totalInvoices} invoices · {c.failedCount} failed ·{" "}
                    {c.pendingCount} pending
                    {c.nextDeadline
                      ? ` · next: ${c.nextDeadline.title} ${formatDate(c.nextDeadline.dueDate)}`
                      : ""}
                    {c.unsubmittedCount > 0 && (
                      <span className="sm:hidden tabular-nums">
                        {" "}
                        · {formatNaira(c.unsubmittedValue)} unsubmitted
                      </span>
                    )}
                  </p>
                </div>
                {c.unsubmittedCount > 0 && (
                  <div className="hidden sm:block text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {formatNaira(c.unsubmittedValue)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.unsubmittedCount} unsubmitted
                    </p>
                  </div>
                )}
                <span
                  className={riskBadgeClasses(c.penaltyRisk)}
                  data-testid={`badge-risk-${c.clientPartyId}`}
                >
                  {riskLabel(c.penaltyRisk)}
                </span>
                <ChevronRight
                  className="hidden size-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <ClerkAdoptionCard />
      </PortfolioSection>

      <PortfolioSection id="money" label="Money">
        <ReceivablesCard />
        <BillingStatementCard />
      </PortfolioSection>

      {/* The two all-self-gating sections render only when at least one
          member card will show — otherwise a role or server build that hides
          every card would leave a bare heading behind a dead anchor chip. */}
      {complianceOccupied && (
        <PortfolioSection id="compliance" label="Compliance">
          <ComplianceCalendarCard />
          <VatPackCard />
          <VatPositionsCard />
          <VatSettlementCard />

          <VatPositionCard />
          <QuarterlyReviewCard />
          <RejectionPatternsCard />
          {/* Practice governance lives with the compliance surfaces it
              shapes — the maker-checker rule gates stamping submissions. */}
          <GovernanceCard />
        </PortfolioSection>
      )}

      {connectionsOccupied && (
        <PortfolioSection id="connections" label="Connections & delivery">
          {/* Bank-feed connections sit with the delivery surfaces. Render-on-
              success: servers without the rail (older build, feature dark →
              404) show nothing at all. */}
          <StatementConnectionsCard
            clients={clients.map((c) => ({
              clientPartyId: c.clientPartyId,
              legalName: c.legalName,
            }))}
          />
          <ClerkWeeklyDigestCard />
          {/* Digest delivery is what these preferences control, so they live
              beside the digest itself. Firm members only — the card self-gates
              on role, mirroring the server's 403 for everyone else. */}
          <StaffNotificationPrefsCard />
        </PortfolioSection>
      )}

      {addClientDialog}
    </div>
  );
}
