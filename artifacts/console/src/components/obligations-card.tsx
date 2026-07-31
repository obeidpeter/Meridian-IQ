import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListObligations,
  useCreateObligation,
  useUpdateObligationStatus,
  useDraftObligationResponse,
  getGetObligationResponsePackUrl,
  getListObligationsQueryKey,
  CreateObligationInputAuthority,
  CreateObligationInputNoticeType,
  CreateObligationInputTaxType,
} from "@workspace/api-client-react";
import type {
  CreateObligationInput,
  Obligation,
  ObligationResponseDraft,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { triggerDownload } from "@/lib/download";
import { formatAmount, formatDate, pillClasses } from "@/lib/format";
import {
  authorityLabel,
  noticeTypeLabel,
  taxTypeLabel,
} from "@/pages/clerk-shared";
import { Copy, Download, Landmark, Plus } from "lucide-react";

// Authority obligations for one client (Notice Desk): every tax-authority
// notice that still needs a response, soonest deadline first, overdue rows
// flagged. Two ways an obligation gets here — a Clerk notice-case approval
// (clerk.tsx), or the inline "Record notice" form below for paper/walk-in
// notices (no model involved, firm staff only server-side). Status moves
// open → responded → closed via the per-row actions.
//
// Response Desk: each OPEN row can expand one inline panel (one open at a
// time) with the two response tools — the deterministic response-bundle PDF
// (a named download, same idiom as the compliance pack) and a drafted
// response letter the partner copies and edits. The platform never sends or
// files anything: the letter is body text for the firm to own, and the
// provenance line always says whether Clerk phrased it or the deterministic
// template did (the server degrades to template on its own).

// The contract's closed catalogues — every select below is bound to them.
const NOTICE_TYPES = Object.values(CreateObligationInputNoticeType);
const AUTHORITIES = Object.values(CreateObligationInputAuthority);
const TAX_TYPES = Object.values(CreateObligationInputTaxType);

// ---- Pure helpers (unit-tested directly) -----------------------------------

/** Local calendar day as YYYY-MM-DD — the comparison floor for "overdue". */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Overdue = still OPEN past its response deadline. A responded obligation is
 * never painted overdue — the response is in, only closure is pending.
 */
export function obligationOverdue(
  o: Pick<Obligation, "status" | "responseDueDate">,
  today: string,
): boolean {
  return o.status === "open" && o.responseDueDate < today;
}

/**
 * The card's rows: everything not yet closed, soonest response deadline
 * first (ISO dates compare lexicographically). Closed obligations drop off —
 * the card is a worklist, not an archive.
 */
export function openObligationRows(
  obligations: Obligation[] | undefined,
): Obligation[] {
  return (obligations ?? [])
    .filter((o) => o.status !== "closed")
    .sort((a, b) => a.responseDueDate.localeCompare(b.responseDueDate));
}

/**
 * Saved-file name for the response bundle PDF: the notice reference
 * sanitized to filename-safe characters ("FIRS/2026/0042" →
 * "response-pack-firs-2026-0042.pdf"), or the obligation id's first 8
 * characters when the notice carries no usable reference.
 */
export function responsePackFilename(
  o: Pick<Obligation, "id" | "reference">,
): string {
  const slug = (o.reference ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `response-pack-${slug || o.id.slice(0, 8)}.pdf`;
}

export interface ObligationDraft {
  noticeType: CreateObligationInput["noticeType"] | "";
  authority: CreateObligationInput["authority"] | "";
  taxType: NonNullable<CreateObligationInput["taxType"]> | "";
  reference: string;
  amount: string;
  issueDate: string;
  responseDueDate: string;
}

export const EMPTY_OBLIGATION_DRAFT: ObligationDraft = {
  noticeType: "",
  authority: "",
  taxType: "",
  reference: "",
  amount: "",
  issueDate: "",
  responseDueDate: "",
};

/** Record is held until the contract's required trio is chosen. */
export function obligationDraftIncomplete(draft: ObligationDraft): boolean {
  return !draft.noticeType || !draft.authority || !draft.responseDueDate;
}

/**
 * Draft -> wire payload: required fields verbatim, optional free-text
 * trimmed and OMITTED when empty (the contract's optionals are
 * absent-or-valued, never "").
 */
export function obligationInputFromDraft(
  clientPartyId: string,
  draft: ObligationDraft,
): CreateObligationInput {
  return {
    clientPartyId,
    // Guarded by obligationDraftIncomplete before submit ever fires.
    noticeType: draft.noticeType as CreateObligationInput["noticeType"],
    authority: draft.authority as CreateObligationInput["authority"],
    responseDueDate: draft.responseDueDate,
    ...(draft.taxType ? { taxType: draft.taxType } : {}),
    ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
    ...(draft.amount.trim() ? { amount: draft.amount.trim() } : {}),
    ...(draft.issueDate ? { issueDate: draft.issueDate } : {}),
  };
}

// ---- The card ---------------------------------------------------------------

export function ObligationsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = { clientPartyId };
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useListObligations(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListObligationsQueryKey(params),
      staleTime: 60_000,
      retry: false,
    },
  });

  // getListObligationsQueryKey() prefix-matches every filtered variant of
  // the list (this client's, other cards', the SME app's twin), so all go
  // stale together after any write.
  const invalidateObligations = () =>
    queryClient.invalidateQueries({ queryKey: getListObligationsQueryKey() });

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<ObligationDraft>(EMPTY_OBLIGATION_DRAFT);

  // Response Desk: which row's response panel is expanded (one at a time),
  // and the last drafted letter. The letter is keyed by obligationId, so it
  // only ever renders under its own row — switching rows hides it without
  // discarding it, and reopening the row brings it back.
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [letter, setLetter] = useState<ObligationResponseDraft | null>(null);

  const draftResponse = useDraftObligationResponse({
    mutation: {
      onSuccess: (d) => setLetter(d),
      onError: (e) =>
        toast({
          title: "Could not draft the letter",
          description: serverErrorMessage(e) ?? "Try again.",
          variant: "destructive",
        }),
    },
  });

  const createObligation = useCreateObligation({
    mutation: {
      onSuccess: (obligation) => {
        invalidateObligations();
        setFormOpen(false);
        setDraft(EMPTY_OBLIGATION_DRAFT);
        toast({
          title: "Notice recorded",
          description: `Obligation recorded — response due ${obligation.responseDueDate}`,
        });
      },
      onError: (e) =>
        toast({
          title: "Could not record the notice",
          description: serverErrorMessage(e) ?? "Try again.",
          variant: "destructive",
        }),
    },
  });

  const updateStatus = useUpdateObligationStatus({
    mutation: {
      onSuccess: (obligation) => {
        invalidateObligations();
        toast({
          title:
            obligation.status === "responded"
              ? "Marked responded"
              : "Obligation closed",
        });
      },
      onError: (e) =>
        toast({
          title: "Could not update the obligation",
          description: serverErrorMessage(e) ?? "Try again.",
          variant: "destructive",
        }),
    },
  });

  const rows = useMemo(() => openObligationRows(data?.obligations), [data]);
  const today = todayIso();

  return (
    <Card data-testid="card-obligations">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="w-5 h-5" aria-hidden="true" /> Authority notices
        </CardTitle>
        <Button
          size="sm"
          variant={formOpen ? "secondary" : "default"}
          onClick={() => setFormOpen((o) => !o)}
          data-testid="button-record-notice"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Record notice
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Inline recorder for notices that never went through Clerk: a
            paper notice handed over at the counter still needs its response
            deadline tracked. */}
        {formOpen && (
          <div className="border rounded-md p-3 space-y-3">
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Notice type</Label>
                <Select
                  value={draft.noticeType}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      noticeType: v as ObligationDraft["noticeType"],
                    })
                  }
                >
                  <SelectTrigger data-testid="select-obligation-notice-type">
                    <SelectValue placeholder="Choose type" />
                  </SelectTrigger>
                  <SelectContent>
                    {NOTICE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {noticeTypeLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Authority</Label>
                <Select
                  value={draft.authority}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      authority: v as ObligationDraft["authority"],
                    })
                  }
                >
                  <SelectTrigger data-testid="select-obligation-authority">
                    <SelectValue placeholder="Choose authority" />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTHORITIES.map((a) => (
                      <SelectItem key={a} value={a}>
                        {authorityLabel(a)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Tax type (optional)</Label>
                <Select
                  value={draft.taxType}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      taxType: v as ObligationDraft["taxType"],
                    })
                  }
                >
                  <SelectTrigger data-testid="select-obligation-tax-type">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {taxTypeLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid sm:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="obl-reference">Reference</Label>
                <Input
                  id="obl-reference"
                  value={draft.reference}
                  onChange={(e) =>
                    setDraft({ ...draft, reference: e.target.value })
                  }
                  data-testid="input-obligation-reference"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="obl-amount">Amount (optional)</Label>
                <Input
                  id="obl-amount"
                  value={draft.amount}
                  onChange={(e) =>
                    setDraft({ ...draft, amount: e.target.value })
                  }
                  data-testid="input-obligation-amount"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="obl-issue">Issue date</Label>
                <Input
                  id="obl-issue"
                  type="date"
                  value={draft.issueDate}
                  onChange={(e) =>
                    setDraft({ ...draft, issueDate: e.target.value })
                  }
                  data-testid="input-obligation-issue-date"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="obl-due">Response due date</Label>
                <Input
                  id="obl-due"
                  type="date"
                  value={draft.responseDueDate}
                  onChange={(e) =>
                    setDraft({ ...draft, responseDueDate: e.target.value })
                  }
                  data-testid="input-obligation-due-date"
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={() =>
                createObligation.mutate({
                  data: obligationInputFromDraft(clientPartyId, draft),
                })
              }
              disabled={
                obligationDraftIncomplete(draft) || createObligation.isPending
              }
              data-testid="button-create-obligation"
            >
              {createObligation.isPending
                ? "Recording…"
                : "Record obligation"}
            </Button>
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-24 w-full" data-testid="skeleton-obligations" />
        ) : error ? (
          <QueryError
            thing="authority notices"
            onRetry={() => refetch()}
            detail={error instanceof Error ? error.message : undefined}
          />
        ) : rows.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-obligations-empty"
          >
            No open notices for this client. Approving a Clerk notice case or
            recording a paper notice tracks its response deadline here.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((o) => {
              const overdue = obligationOverdue(o, today);
              return (
                <div
                  key={o.id}
                  className={`border rounded-md p-3 ${
                    overdue
                      ? "border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20"
                      : ""
                  }`}
                  data-testid={`row-obligation-${o.id}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-medium text-sm">
                      {noticeTypeLabel(o.noticeType)} ·{" "}
                      {authorityLabel(o.authority)}
                    </p>
                    <span
                      className={pillClasses(
                        overdue
                          ? "red"
                          : o.status === "responded"
                            ? "blue"
                            : "amber",
                      )}
                      data-testid={`pill-obligation-${o.id}`}
                    >
                      {overdue
                        ? "Overdue"
                        : o.status === "responded"
                          ? "Responded"
                          : "Open"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {o.reference ? `Ref ${o.reference} · ` : ""}
                    Response due {formatDate(o.responseDueDate)}
                    {o.amount
                      ? ` · ${formatAmount(o.amount, o.currency ?? "NGN")}`
                      : ""}
                  </p>
                  <div className="flex gap-2 mt-2">
                    {o.status === "open" && (
                      <Button
                        size="sm"
                        variant={
                          respondingId === o.id ? "secondary" : "outline"
                        }
                        onClick={() =>
                          setRespondingId((cur) =>
                            cur === o.id ? null : o.id,
                          )
                        }
                        data-testid={`button-obligation-respond-${o.id}`}
                      >
                        Prepare response
                      </Button>
                    )}
                    {o.status === "open" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateStatus.mutate({
                            id: o.id,
                            data: { status: "responded" },
                          })
                        }
                        disabled={updateStatus.isPending}
                        data-testid={`button-obligation-responded-${o.id}`}
                      >
                        Mark responded
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateStatus.mutate({
                          id: o.id,
                          data: { status: "closed" },
                        })
                      }
                      disabled={updateStatus.isPending}
                      data-testid={`button-obligation-close-${o.id}`}
                    >
                      Close
                    </Button>
                  </div>
                  {o.status === "open" && respondingId === o.id && (
                    <div
                      className="mt-2 rounded-md border p-3 space-y-2"
                      data-testid={`panel-obligation-respond-${o.id}`}
                    >
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            triggerDownload(
                              getGetObligationResponsePackUrl({
                                obligationId: o.id,
                              }),
                              responsePackFilename(o),
                            )
                          }
                          data-testid={`button-response-pack-${o.id}`}
                        >
                          <Download
                            className="w-3.5 h-3.5 mr-1.5"
                            aria-hidden="true"
                          />
                          Download response bundle (PDF)
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            // Empty body: the server defaults the month to
                            // the notice's issue month.
                            draftResponse.mutate({ id: o.id, data: {} })
                          }
                          disabled={draftResponse.isPending}
                          data-testid={`button-response-draft-${o.id}`}
                        >
                          {draftResponse.isPending
                            ? "Drafting…"
                            : "Draft response letter"}
                        </Button>
                      </div>
                      {letter && letter.obligationId === o.id && (
                        <div className="space-y-2">
                          <p
                            className="text-xs font-medium text-muted-foreground"
                            data-testid={`text-response-provenance-${o.id}`}
                          >
                            {letter.monthLabel ? `${letter.monthLabel} — ` : ""}
                            {letter.source === "clerk"
                              ? "Drafted by Clerk from the period's records — review and edit before sending."
                              : "Assembled from the period's records (Clerk unavailable) — review and edit before sending."}
                          </p>
                          <Textarea
                            readOnly
                            value={letter.letter}
                            className="min-h-[140px] text-sm"
                            data-testid={`text-response-letter-${o.id}`}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(
                                  letter.letter,
                                );
                                toast({ title: "Letter copied" });
                              } catch {
                                toast({
                                  title: "Could not copy",
                                  description:
                                    "Select the text and copy it manually.",
                                  variant: "destructive",
                                });
                              }
                            }}
                            data-testid={`button-copy-letter-${o.id}`}
                          >
                            <Copy
                              className="w-3.5 h-3.5 mr-1.5"
                              aria-hidden="true"
                            />
                            Copy letter
                          </Button>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        The platform never sends or files the response — this
                        is a draft for the firm to own.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
