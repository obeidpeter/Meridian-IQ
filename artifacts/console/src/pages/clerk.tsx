import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListClerkCases,
  useGetClerkCase,
  useCreateClerkCase,
  useDecideClerkCase,
  useClaimClerkCase,
  useReleaseClerkCase,
  useRetryClerkCase,
  useAskClerk,
  useGetClerkPartySuggestions,
  useListFirms,
  useListParties,
  getListClerkCasesQueryKey,
  getGetClerkCaseQueryKey,
  getGetClerkPartySuggestionsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkCase,
  ClerkCaseCreateInput,
  ClerkCaseDecisionInputCategory,
  InvoiceLineInput,
  ListClerkCasesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  errorStatus,
  killSwitchTripped,
  serverErrorMessage,
} from "@/lib/errors";
import { formatDateTime, pillClasses } from "@/lib/format";
import { AskPanel } from "@/pages/clerk-ask";
import { HealthPanel } from "@/pages/clerk-health";
import { PartySuggestionChips } from "@/pages/clerk-party-suggestions";
import { STATUS_TONE } from "@/pages/clerk-shared";
import {
  MAX_RECORD_SECONDS,
  MAX_VOICE_BYTES,
  useVoiceRecorder,
} from "@/pages/use-voice-recorder";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Clock3,
  FileImage,
  FileText,
  FileUp,
  Keyboard,
  MessageCircleQuestion,
  Mic,
  Plus,
  PowerOff,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Clerk v0 is a shadow copilot for operators only. It reads documents and
// answers register questions, but it NEVER submits anything: an approval here
// creates a DRAFT invoice that still walks the normal human submission path.
// If the clerk_ai kill switch is off, the server answers 503 and this page
// says so instead of pretending.

const CATEGORIES: ClerkCaseDecisionInputCategory[] = ["b2b", "b2g", "b2c"];

// The case queue loads in pages: with limit/offset present the server
// returns a bounded, newest-first slice instead of the full legacy list. A
// full page means there may be more — "Load more" appends the next one.
const PAGE_SIZE = 50;

const SOURCE_META: Record<
  string,
  { label: string; Icon: LucideIcon; tone: string }
> = {
  pdf: {
    label: "PDF",
    Icon: FileText,
    tone: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  },
  image: {
    label: "Image",
    Icon: FileImage,
    tone: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  },
  voice: {
    label: "Voice",
    Icon: Mic,
    tone: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  },
  text: {
    label: "Text",
    Icon: Keyboard,
    tone: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
};

const DEFAULT_SOURCE_META = {
  label: "Source",
  Icon: FileUp,
  tone: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

function sourceMeta(sourceType: string | null | undefined) {
  return (sourceType && SOURCE_META[sourceType]) || DEFAULT_SOURCE_META;
}

function statusLabel(status: ClerkCase["status"]): string {
  return status.replace(/_/g, " ");
}

function fieldValue(kase: ClerkCase, field: string): string {
  return (
    kase.extraction?.fields.find((f) => f.field === field)?.value ?? ""
  );
}

// Read a File into plain base64. Bytes are encoded directly (chunked to stay
// under the argument limit), so no data: URL prefix is ever produced — the
// backend strips one anyway.
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Coarse "n min ago" for claim ages — precision doesn't matter here.
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// Operator ids are opaque — show enough to tell operators apart.
function shortActor(id: string | null | undefined): string {
  if (!id) return "unknown";
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

interface ApproveForm {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  category: ClerkCaseDecisionInputCategory;
  lines: InvoiceLineInput[];
}

// The API takes VAT rates as FRACTIONS ("0.075" = 7.5%) and rejects
// percent-style values loudly. The operator edits a percent in this form, so
// we normalise the extracted value to percent for display and convert back to
// a fraction on submit. If extraction found no usable VAT rate we leave the
// field EMPTY — never invent a default tax rate; the operator must enter one
// deliberately before approval is allowed.
function vatPercentFromRaw(raw: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  const n = Number(trimmed.replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0) return "";
  if (trimmed.includes("%")) return String(n);
  // Round away float artifacts (0.07 * 100 → 7.000000000000001).
  return String(n <= 1 ? Number((n * 100).toFixed(6)) : n);
}

function vatFractionFromPercent(pct: string): string {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return "";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return pct;
  return String(n / 100);
}

// A line's VAT % is submittable only if it is an explicit number in [0, 100].
function vatPercentInvalid(pct: string): boolean {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return true;
  const n = Number(trimmed);
  return !Number.isFinite(n) || n < 0 || n > 100;
}

function approveFormFromCase(kase: ClerkCase): ApproveForm {
  return {
    firmId: "",
    supplierPartyId: "",
    buyerPartyId: "",
    invoiceNumber: fieldValue(kase, "invoiceNumber"),
    issueDate: fieldValue(kase, "issueDate"),
    dueDate: fieldValue(kase, "dueDate"),
    currency: fieldValue(kase, "currency") || "NGN",
    category: "b2b",
    lines: (kase.extraction?.lines ?? []).map((l) => ({
      description: l.description ?? "",
      quantity: l.quantity ?? "1",
      unitPrice: l.unitPrice ?? "0",
      vatRate: vatPercentFromRaw(l.vatRate),
    })),
  };
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.9
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
      : confidence >= 0.75
        ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        : "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300";
  return (
    <span
      className={`inline-flex min-w-12 items-center justify-center rounded-full border px-2 py-1 text-[11px] font-semibold tabular-nums ${tone}`}
    >
      {pct}%
    </span>
  );
}

export function ClerkWorkspace() {
  usePageTitle("Clerk AI");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  // Paged case queue. The Capture tab only ever shows extraction cases, so
  // that kind filter now travels to the server with the page bounds (any
  // filter change would restart from the first page — offset only ever grows
  // within one filter set). Only the page at `offset` is a live query;
  // earlier pages are kept in local state and re-appended below.
  const [offset, setOffset] = useState(0);
  const [earlierCases, setEarlierCases] = useState<ClerkCase[]>([]);
  const caseParams: ListClerkCasesParams = {
    kind: "extraction",
    limit: PAGE_SIZE,
    offset,
  };
  const {
    data: casePage,
    isLoading,
    error,
    refetch,
  } = useListClerkCases(caseParams, {
    query: { queryKey: getListClerkCasesQueryKey(caseParams) },
  });

  // The queue shifts while paging (a new capture pushes every row down one
  // slot), so a case can be returned by two page fetches — dedupe by id to
  // keep React keys unique.
  const cases = useMemo(() => {
    const seen = new Set<string>();
    const merged: ClerkCase[] = [];
    for (const c of [...earlierCases, ...(casePage ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
    return merged;
  }, [earlierCases, casePage]);

  // A short page is the end of the queue. When the total is an exact
  // multiple of PAGE_SIZE the last click fetches one empty page — harmless.
  const hasMoreCases = (casePage?.length ?? 0) === PAGE_SIZE;
  const loadingMoreCases = isLoading && offset > 0;
  const loadMoreCases = () => {
    if (!casePage) return;
    setEarlierCases((prev) => [...prev, ...casePage]);
    setOffset((o) => o + PAGE_SIZE);
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: selected } = useGetClerkCase(selectedId ?? "", {
    query: {
      queryKey: getGetClerkCaseQueryKey(selectedId ?? ""),
      enabled: selectedId != null,
    },
  });

  // Capture form
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureFile, setCaptureFile] = useState<File | null>(null);
  const [captureVoice, setCaptureVoice] = useState<File | null>(null);
  // Duplicate guard: a 409 DUPLICATE_SOURCE on create means this exact
  // document content already has a live case. We hold the rejected payload
  // verbatim so "Create anyway" resubmits it byte-identical with
  // allowDuplicate: true. Cleared on success, on cancel, and whenever the
  // operator changes any source input (the held payload would be stale).
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    payload: ClerkCaseCreateInput;
    message: string;
  } | null>(null);

  // Decision form
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (selected && (selected.status === "extracted" || selected.status === "in_review")) {
      setForm(approveFormFromCase(selected));
    } else {
      setForm(null);
    }
    setReason("");
    // Reset only when the case identity or status changes: a react-query
    // refetch delivers a fresh `selected` reference with the same id/status
    // mid-edit, and depending on the object would clobber operator input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  const { data: firms } = useListFirms();
  const { data: parties } = useListParties();

  // Party-matching suggestions for the open approval form, fetched only
  // while the form is open for an extraction case. A failed fetch is silent:
  // suggestions are a convenience, the plain dropdowns keep working.
  const suggestionsCaseId =
    form != null && selected?.kind === "extraction" ? selected.id : null;
  const { data: partySuggestions } = useGetClerkPartySuggestions(
    suggestionsCaseId ?? "",
    {
      query: {
        queryKey: getGetClerkPartySuggestionsQueryKey(suggestionsCaseId ?? ""),
        enabled: suggestionsCaseId != null,
      },
    },
  );

  // Pre-select the top suggestion for any party slot the operator has not
  // picked yet. Only empty slots are ever filled — an operator's choice is
  // never overwritten, and the selects stay fully open to any other party.
  useEffect(() => {
    if (!partySuggestions) return;
    setForm((f) => {
      if (!f) return f;
      const supplierPartyId =
        f.supplierPartyId || (partySuggestions.supplier[0]?.partyId ?? "");
      const buyerPartyId =
        f.buyerPartyId || (partySuggestions.buyer[0]?.partyId ?? "");
      if (
        supplierPartyId === f.supplierPartyId &&
        buyerPartyId === f.buyerPartyId
      ) {
        return f;
      }
      return { ...f, supplierPartyId, buyerPartyId };
    });
  }, [partySuggestions, form]);

  const handleGatewayError = (err: unknown, fallback: string) => {
    if (killSwitchTripped(err)) {
      setDisabledBanner(true);
      toast({
        title: "Clerk is switched off",
        description:
          "The clerk_ai kill switch is disabled, so no AI calls are being made.",
        variant: "destructive",
      });
      return;
    }
    // Relay the server's own words when it sent any — typed rejections
    // (VOICE_UNREADABLE / VOICE_NO_SPEECH 422s, CASE_CLAIMED /
    // CASE_CLAIM_CONFLICT 409s) carry an actionable message.
    toast({
      title: "Something went wrong",
      description: serverErrorMessage(err) ?? fallback,
      variant: "destructive",
    });
  };

  const invalidateCases = () => {
    // Reset paging before invalidating: fresh data trumps scroll position.
    // Only the first page stays mounted, so the refetch starts from the top
    // of the queue instead of stitching stale appended pages onto new data.
    setEarlierCases([]);
    setOffset(0);
    // getListClerkCasesQueryKey({}) prefix-matches every paged/filtered
    // variant of the list, so all cached pages go stale together.
    queryClient.invalidateQueries({ queryKey: getListClerkCasesQueryKey({}) });
    if (selectedId) {
      queryClient.invalidateQueries({
        queryKey: getGetClerkCaseQueryKey(selectedId),
      });
    }
  };

  const createCase = useCreateClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        setSelectedId(kase.id);
        setCaptureOpen(false);
        setCaptureText("");
        setCaptureFile(null);
        setCaptureVoice(null);
        setVoiceFromRecorder(false);
        setPendingDuplicate(null);
        setDisabledBanner(false);
        toast({
          title:
            kase.status === "failed"
              ? "Reading failed"
              : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e, variables) => {
        // 409 DUPLICATE_SOURCE: the same content already has a live case.
        // No toast — an inline panel lets the operator create anyway
        // (allowDuplicate: true) or back out.
        if (errorStatus(e) === 409) {
          setPendingDuplicate({
            payload: variables.data,
            message:
              serverErrorMessage(e) ??
              "This exact document already has a live case.",
          });
          return;
        }
        handleGatewayError(e, "Could not read the document.");
      },
    },
  });

  const decideCase = useDecideClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.decisionAction === "approve"
              ? "Draft invoice created"
              : `Case ${kase.status}`,
          description:
            kase.decisionAction === "approve"
              ? "The Clerk never submits: the draft goes through the normal review and submission flow."
              : undefined,
        });
      },
      onError: (e) => handleGatewayError(e, "Could not record the decision."),
    },
  });

  // Claiming is optional (a solo operator can decide straight from
  // "extracted") — it just tells other operators someone is on the case. A
  // 409 means someone else won the race, so refetch to show the real claimant.
  const claimCase = useClaimClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case claimed",
          description:
            "You're on it — other operators now see this case as in review.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not claim the case.");
      },
    },
  });

  const releaseCase = useReleaseClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case released",
          description: "The case is back in the queue for any operator.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not release the case.");
      },
    },
  });

  // Retry is only valid for failed extraction cases — the server 409s
  // anything else, and handleGatewayError relays its words.
  const retryCase = useRetryClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.status === "failed" ? "Reading failed again" : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk still could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e) => handleGatewayError(e, "Could not retry the extraction."),
    },
  });

  const ask = useAskClerk({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        setDisabledBanner(false);
      },
      onError: (e) => handleGatewayError(e, "Could not ask the Clerk."),
    },
  });
  const [question, setQuestion] = useState("");

  // True when the current captureVoice came from the in-browser recorder
  // rather than an attached audio file — drives the "Recorded note ready"
  // label next to the record button.
  const [voiceFromRecorder, setVoiceFromRecorder] = useState(false);
  const {
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
  } = useVoiceRecorder({
    // The recorded blob is fed through the SAME captureVoice path as an
    // attached audio file, so submit, duplicate guard and post-success reset
    // all behave identically.
    onRecorded: (file) => {
      setCaptureVoice(file);
      setVoiceFromRecorder(true);
    },
    // Starting a new recording invalidates the held duplicate payload.
    onCleared: () => setPendingDuplicate(null),
  });

  const submitCapture = async () => {
    if (captureVoice) {
      const b64 = await fileToBase64(captureVoice);
      createCase.mutate({
        data: {
          sourceType: "voice",
          audioBase64: b64,
          name: captureVoice.name,
        },
      });
    } else if (captureFile) {
      const isPdf =
        captureFile.type === "application/pdf" ||
        captureFile.name.toLowerCase().endsWith(".pdf");
      const b64 = await fileToBase64(captureFile);
      createCase.mutate({
        data: {
          sourceType: isPdf ? "pdf" : "image",
          name: captureFile.name,
          contentType: captureFile.type || undefined,
          ...(isPdf ? { pdfBase64: b64 } : { imageBase64: b64 }),
        },
      });
    } else if (captureText.trim()) {
      createCase.mutate({
        data: {
          sourceType: "text",
          name: "pasted-text.txt",
          text: captureText,
        },
      });
    }
  };

  const sortedCases = useMemo(
    () =>
      [...cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [cases],
  );

  const readyCount = sortedCases.filter((c) => c.status === "extracted").length;
  const inReviewCount = sortedCases.filter(
    (c) => c.status === "in_review",
  ).length;
  const failedCount = sortedCases.filter((c) => c.status === "failed").length;
  const selectedFields = selected?.extraction?.fields ?? [];
  const flaggedFieldCount = selectedFields.filter(
    (field) => field.flagged,
  ).length;
  const averageConfidence =
    selectedFields.length > 0
      ? Math.round(
          (selectedFields.reduce((sum, field) => sum + field.confidence, 0) /
            selectedFields.length) *
            100,
        )
      : null;
  const selectedSource = sourceMeta(selected?.sourceType);
  const SelectedSourceIcon = selectedSource.Icon;

  const approveDisabled =
    !form ||
    !form.firmId ||
    !form.supplierPartyId ||
    !form.buyerPartyId ||
    !form.invoiceNumber.trim() ||
    !form.issueDate ||
    form.lines.length === 0 ||
    form.lines.some(
      (l) =>
        !l.description.trim() ||
        !l.quantity ||
        !l.unitPrice ||
        vatPercentInvalid(l.vatRate),
    );

  // Only the FIRST page's load blanks the whole workspace; loading a later
  // page keeps the rows already on screen and spins the Load more button.
  if (isLoading && offset === 0) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-96" />
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Skeleton className="h-[34rem] rounded-lg" />
          <Skeleton className="h-[34rem] rounded-lg" />
        </div>
      </div>
    );
  }
  if (error) return <QueryError thing="Clerk cases" onRetry={refetch} />;

  const setLine = (i: number, patch: Partial<InvoiceLineInput>) => {
    if (!form) return;
    setForm({
      ...form,
      lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    });
  };

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-lg border border-[#16494a] bg-[#082728] text-white shadow-sm">
        <div
          className="absolute inset-y-0 right-0 hidden w-[28%] border-l border-white/10 bg-[#103839] lg:block"
          aria-hidden="true"
        />
        <div className="relative flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg border border-lime-200/30 bg-lime-300 text-[#082728] shadow-sm">
              <Bot className="size-6" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-lime-300">
                Operations copilot
              </p>
              <h1 className="mt-1 text-2xl font-semibold">Clerk AI</h1>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium text-white/75">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1">
                  <ShieldCheck
                    className="size-3.5 text-lime-300"
                    aria-hidden="true"
                  />
                  Human decision required
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1">
                  <BookOpenCheck
                    className="size-3.5 text-sky-300"
                    aria-hidden="true"
                  />
                  Claims-register grounded
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div
              className="grid min-w-48 grid-cols-2 divide-x divide-white/10 rounded-lg border border-white/15 bg-white/5"
              aria-label="Counts for currently loaded cases"
              title={`${sortedCases.length} loaded cases`}
            >
              <div className="px-4 py-3">
                <p className="text-[11px] font-medium uppercase text-white/50">
                  Ready
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {readyCount}
                </p>
              </div>
              <div className="px-4 py-3">
                <p className="text-[11px] font-medium uppercase text-white/50">
                  In review
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {inReviewCount}
                </p>
              </div>
            </div>
            <Link
              href="/clerk/claims"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-white/20 bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
            >
              Claims register
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {disabledBanner && (
        <Alert variant="destructive" data-testid="banner-clerk-disabled">
          <PowerOff className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Clerk is switched off</AlertTitle>
          <AlertDescription>
            The <code>clerk_ai</code> feature flag is disabled. No AI calls are
            made while it is off — re-enable it under Feature flags.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="capture" className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-3 rounded-lg border bg-card p-1 text-muted-foreground shadow-sm sm:w-fit">
          <TabsTrigger
            value="capture"
            className="h-10 gap-2 rounded-md px-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none sm:px-4"
            data-testid="tab-capture"
          >
            <FileUp className="size-4" aria-hidden="true" /> Capture
          </TabsTrigger>
          <TabsTrigger
            value="ask"
            className="h-10 gap-2 rounded-md px-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none sm:px-4"
            data-testid="tab-ask"
          >
            <MessageCircleQuestion className="size-4" aria-hidden="true" />
            Ask Clerk
          </TabsTrigger>
          <TabsTrigger
            value="health"
            className="h-10 gap-2 rounded-md px-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none sm:px-4"
            data-testid="tab-health"
          >
            <Activity className="size-4" aria-hidden="true" /> Health
          </TabsTrigger>
        </TabsList>

        <TabsContent value="capture" className="mt-0">
          <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[21rem_minmax(0,1fr)]">
            <Card className="min-w-0 overflow-hidden rounded-lg shadow-sm">
              <Dialog
                open={captureOpen}
                onOpenChange={(open) => {
                  setCaptureOpen(open);
                  if (!open) setPendingDuplicate(null);
                }}
              >
                <CardHeader className="flex min-h-[4.5rem] flex-row items-center justify-between space-y-0 border-b p-4">
                  <div>
                    <CardTitle className="text-base">Intake queue</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sortedCases.length} loaded
                    </p>
                  </div>
                  <DialogTrigger asChild>
                    <Button
                      size="icon"
                      aria-label="New capture"
                      title="New capture"
                      data-testid="button-new-capture"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </DialogTrigger>
                </CardHeader>
                <CardContent className="p-0">
                  <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto p-0">
                    <DialogHeader className="border-b bg-teal-50/70 p-6 pr-12 text-left dark:bg-teal-950/20">
                      <div className="flex items-start gap-3">
                        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                          <Sparkles className="size-5" aria-hidden="true" />
                        </span>
                        <div>
                          <DialogTitle>New Clerk capture</DialogTitle>
                          <DialogDescription className="mt-1.5">
                            Add one source for extraction. A human review is
                            still required before a draft invoice is created.
                          </DialogDescription>
                        </div>
                      </div>
                    </DialogHeader>
                    <div className="space-y-5 p-6">
                      <section className="space-y-3 border-b pb-5">
                        <div className="flex items-start gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                            <FileUp className="size-4" aria-hidden="true" />
                          </span>
                          <div>
                            <Label htmlFor="capture-file">Document</Label>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              PDF, PNG, JPEG or WebP
                            </p>
                          </div>
                        </div>
                        <Label htmlFor="capture-file">
                          <span className="sr-only">Invoice document</span>
                        </Label>
                        <Input
                          id="capture-file"
                          type="file"
                          accept=".pdf,image/png,image/jpeg,image/webp"
                          onChange={(e) => {
                            setCaptureFile(e.target.files?.[0] ?? null);
                            setPendingDuplicate(null);
                          }}
                          disabled={captureVoice != null}
                          data-testid="input-capture-file"
                        />
                      </section>

                      <section className="space-y-3 border-b pb-5">
                        <div className="flex items-start gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                            <Mic className="size-4" aria-hidden="true" />
                          </span>
                          <div>
                            <Label htmlFor="capture-voice">Voice note</Label>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              English audio, up to 5 MB
                            </p>
                          </div>
                        </div>
                        <Input
                          id="capture-voice"
                          type="file"
                          accept="audio/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0] ?? null;
                            setPendingDuplicate(null);
                            setVoiceFromRecorder(false);
                            if (f && f.size > MAX_VOICE_BYTES) {
                              toast({
                                title: "Voice note too large",
                                description: `Voice notes are capped at 5 MB; this file is ${(
                                  f.size /
                                  (1024 * 1024)
                                ).toFixed(1)} MB. Record a shorter note.`,
                                variant: "destructive",
                              });
                              e.target.value = "";
                              setCaptureVoice(null);
                              return;
                            }
                            setCaptureVoice(f);
                          }}
                          disabled={captureFile != null || isRecording}
                          data-testid="input-voice-file"
                        />
                        {recordingSupported && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button
                              type="button"
                              size="sm"
                              variant={
                                isRecording ? "destructive" : "secondary"
                              }
                              onClick={
                                isRecording ? stopRecording : startRecording
                              }
                              disabled={
                                createCase.isPending ||
                                (!isRecording && captureFile != null)
                              }
                              data-testid="button-record-voice"
                            >
                              <Mic className="size-4" aria-hidden="true" />
                              {isRecording
                                ? "Stop recording"
                                : "Record voice note"}
                            </Button>
                            <span
                              className="text-xs text-muted-foreground tabular-nums"
                              aria-live="polite"
                              data-testid="text-record-elapsed"
                            >
                              {isRecording
                                ? `Recording… ${recordSeconds}s (stops at ${MAX_RECORD_SECONDS}s)`
                                : voiceFromRecorder && captureVoice != null
                                  ? "Recorded note ready — recording.webm"
                                  : ""}
                            </span>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          English voice notes; the audio is transcribed and only
                          the transcript is kept.
                        </p>
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-start gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                            <Keyboard className="size-4" aria-hidden="true" />
                          </span>
                          <div>
                            <Label htmlFor="capture-text">Pasted text</Label>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Invoice content copied from another source
                            </p>
                          </div>
                        </div>
                        <Textarea
                          id="capture-text"
                          value={captureText}
                          onChange={(e) => {
                            setCaptureText(e.target.value);
                            setPendingDuplicate(null);
                          }}
                          placeholder="INVOICE No: ..."
                          rows={5}
                          disabled={captureFile != null || captureVoice != null}
                          data-testid="input-capture-text"
                        />
                      </section>
                      {pendingDuplicate && (
                        <Alert data-testid="banner-duplicate-source">
                          <AlertTriangle
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <AlertTitle>Already read this one?</AlertTitle>
                          <AlertDescription className="space-y-2">
                            <p>{pendingDuplicate.message}</p>
                            <div className="flex gap-2 flex-wrap">
                              <Button
                                size="sm"
                                onClick={() =>
                                  createCase.mutate({
                                    data: {
                                      ...pendingDuplicate.payload,
                                      allowDuplicate: true,
                                    },
                                  })
                                }
                                disabled={createCase.isPending}
                                data-testid="button-create-anyway"
                              >
                                {createCase.isPending
                                  ? "Reading…"
                                  : "Create anyway"}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setPendingDuplicate(null)}
                                data-testid="button-cancel-duplicate"
                              >
                                Cancel
                              </Button>
                            </div>
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                    <DialogFooter className="border-t bg-muted/30 px-6 py-4 sm:space-x-2">
                      <DialogClose asChild>
                        <Button variant="secondary">Cancel</Button>
                      </DialogClose>
                      <Button
                        onClick={submitCapture}
                        disabled={
                          createCase.isPending ||
                          (!captureFile &&
                            !captureVoice &&
                            captureText.trim().length < 10)
                        }
                        data-testid="button-run-capture"
                      >
                        <ScanLine className="size-4" aria-hidden="true" />
                        {createCase.isPending
                          ? captureVoice
                            ? "Transcribing…"
                            : "Reading…"
                          : "Read with Clerk"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                  <div className="grid grid-cols-3 border-b bg-muted/25">
                    {[
                      {
                        label: "Ready",
                        value: readyCount,
                        tone: "text-emerald-700 dark:text-emerald-400",
                      },
                      {
                        label: "Review",
                        value: inReviewCount,
                        tone: "text-amber-700 dark:text-amber-400",
                      },
                      {
                        label: "Failed",
                        value: failedCount,
                        tone: "text-red-700 dark:text-red-400",
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="border-r px-3 py-3 text-center last:border-r-0"
                      >
                        <p
                          className={`text-sm font-semibold tabular-nums ${item.tone}`}
                        >
                          {item.value}
                        </p>
                        <p className="mt-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                          {item.label}
                        </p>
                      </div>
                    ))}
                  </div>
                  {/* The query is already extraction-only (kind param), so no
                    client-side kind filter is needed here anymore. */}
                  {sortedCases.length === 0 ? (
                    <div className="px-5 py-12 text-center">
                      <span className="mx-auto grid size-11 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <FileUp className="size-5" aria-hidden="true" />
                      </span>
                      <p className="mt-3 text-sm font-medium">
                        No captures yet
                      </p>
                      <button
                        type="button"
                        className="mt-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setCaptureOpen(true)}
                      >
                        Start a capture
                      </button>
                    </div>
                  ) : (
                    <div className="max-h-[42rem] divide-y overflow-y-auto">
                      {sortedCases.map((c) => {
                        const meta = sourceMeta(c.sourceType);
                        const SourceIcon = meta.Icon;
                        return (
                          <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          aria-pressed={selectedId === c.id}
                            className={`group grid min-h-[4.75rem] w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 border-l-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 ${
                              selectedId === c.id
                                ? "border-l-primary bg-primary/5"
                                : "border-l-transparent"
                            }`}
                            data-testid={`row-case-${c.id}`}
                          >
                            <span
                              className={`grid size-9 place-items-center rounded-md ${meta.tone}`}
                            >
                              <SourceIcon
                                className="size-4"
                                aria-hidden="true"
                              />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {c.sourceName ?? "Untitled"}
                              </span>
                              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                {meta.label} · {formatDateTime(c.createdAt)}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              {c.status === "in_review" && (
                                <span
                                  className="sr-only"
                                  data-testid={`indicator-claimed-${c.id}`}
                                >
                                  claimed
                                </span>
                              )}
                              <span
                                className={pillClasses(
                                  STATUS_TONE[c.status] ?? "slate",
                                )}
                              >
                                {statusLabel(c.status)}
                              </span>
                              <ChevronRight
                                className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                                aria-hidden="true"
                              />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(hasMoreCases || loadingMoreCases) && (
                    <div className="border-t p-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        onClick={loadMoreCases}
                        disabled={loadingMoreCases}
                        data-testid="button-load-more-cases"
                      >
                        {loadingMoreCases ? "Loading…" : "Load more"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Dialog>
            </Card>

            <Card className="min-w-0 overflow-hidden rounded-lg shadow-sm">
              <CardHeader className="min-h-[4.5rem] border-b bg-muted/15 p-4">
                {selected ? (
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`grid size-10 shrink-0 place-items-center rounded-md ${selectedSource.tone}`}
                    >
                      <SelectedSourceIcon
                        className="size-4"
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                        {selectedSource.label} case
                      </p>
                      <CardTitle className="mt-1 truncate text-base">
                        {selected.sourceName ?? "Case detail"}
                      </CardTitle>
                    </div>
                    <span
                      className={pillClasses(
                        STATUS_TONE[selected.status] ?? "slate",
                      )}
                    >
                      {statusLabel(selected.status)}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-md bg-muted text-muted-foreground">
                      <ScanLine className="size-4" aria-hidden="true" />
                    </span>
                    <CardTitle className="text-base">Case review</CardTitle>
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {!selected ? (
                  <div className="grid min-h-[29rem] place-items-center px-6 py-12 text-center">
                    <div>
                      <span className="mx-auto grid size-14 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
                        <Bot className="size-6" aria-hidden="true" />
                      </span>
                      <p className="mt-4 text-sm font-semibold">
                        Select a case to begin review
                      </p>
                      <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                        The source, extraction confidence and human decision
                        controls will appear here.
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-4"
                        onClick={() => setCaptureOpen(true)}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        New capture
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {selected.extraction && (
                      <div className="grid border-b bg-slate-50/80 sm:grid-cols-3 dark:bg-slate-900/30">
                        <div className="flex items-center gap-3 border-b px-4 py-3 sm:border-b-0 sm:border-r">
                          <CheckCircle2
                            className="size-4 text-emerald-600"
                            aria-hidden="true"
                          />
                          <div>
                            <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                              Avg. confidence
                            </p>
                            <p className="mt-0.5 text-sm font-semibold tabular-nums">
                              {averageConfidence == null
                                ? "n/a"
                                : `${averageConfidence}%`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 border-b px-4 py-3 sm:border-b-0 sm:border-r">
                          <AlertTriangle
                            className="size-4 text-amber-600"
                            aria-hidden="true"
                          />
                          <div>
                            <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                              Fields to check
                            </p>
                            <p className="mt-0.5 text-sm font-semibold tabular-nums">
                              {flaggedFieldCount}
                            </p>
                          </div>
                        </div>
                        <div className="flex min-w-0 items-center gap-3 px-4 py-3">
                          <Sparkles
                            className="size-4 shrink-0 text-violet-600"
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                              Inference
                            </p>
                            <p className="mt-0.5 truncate text-xs font-medium">
                              {selected.extraction.model} ·{" "}
                              {selected.extraction.promptVersion}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {selected.status === "failed" && (
                      <div className="border-b p-4 sm:p-5">
                        <Alert variant="destructive">
                          <AlertTriangle
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <AlertTitle>Reading failed</AlertTitle>
                          <AlertDescription className="space-y-2">
                            <p>
                              {selected.failReason ??
                                "The Clerk could not read this document. Enter the invoice manually."}
                            </p>
                            {/* Retry re-runs extraction on the stored source —
                                only failed extraction cases qualify (the server
                                409s anything else). */}
                            {selected.kind === "extraction" && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  retryCase.mutate({ id: selected.id })
                                }
                                disabled={retryCase.isPending}
                                data-testid="button-retry-case"
                              >
                                {retryCase.isPending ? "Retrying…" : "Retry"}
                              </Button>
                            )}
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}
                    {selected.status === "escalated" && (
                      <div className="border-b p-4 sm:p-5">
                        <Alert>
                          <AlertTriangle
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                          <AlertTitle>Escalated</AlertTitle>
                          <AlertDescription>
                            {selected.decisionReason ??
                              "This case needs a human decision outside the Clerk."}
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}

                    {selected.extraction && (
                      <section className="border-b p-4 sm:p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold">
                              Extraction review
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Amber rows require operator attention.
                            </p>
                          </div>
                          <span className="text-xs font-medium text-muted-foreground tabular-nums">
                            {selected.extraction.fields.length} fields
                          </span>
                        </div>
                        <div className="mt-4 divide-y overflow-hidden rounded-lg border text-sm">
                          {selected.extraction.fields.map((f) => (
                            <div
                              key={f.field}
                              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] ${
                                f.flagged
                                  ? "bg-amber-50 dark:bg-amber-950/40"
                                  : ""
                              }`}
                              data-testid={`row-field-${f.field}`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <code className="truncate text-xs font-medium">
                                  {f.field}
                                </code>
                                {f.critical && (
                                  <span className="rounded-sm bg-slate-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                    Critical
                                  </span>
                                )}
                              </span>
                              <span className="order-3 col-span-2 min-w-0 break-words text-sm sm:order-2 sm:col-span-1">
                                {f.value ?? (
                                  <em className="text-muted-foreground">
                                    missing
                                  </em>
                                )}
                              </span>
                              <span className="order-2 sm:order-3">
                                <ConfidenceBadge confidence={f.confidence} />
                              </span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {selected.status === "approved" &&
                      selected.createdInvoiceId && (
                        <div className="border-b p-4 sm:p-5">
                          <Alert data-testid="banner-draft-created">
                            <ShieldCheck
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            <AlertTitle>Draft invoice created</AlertTitle>
                            <AlertDescription>
                              The invoice was created as a DRAFT. It has not
                              been submitted — it follows the normal human
                              submission flow.
                            </AlertDescription>
                          </Alert>
                        </div>
                      )}

                    {form && (
                      <div className="border-t">
                        <div className="flex items-start gap-3 border-b bg-teal-50/70 p-4 dark:bg-teal-950/20 sm:p-5">
                          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                            <ShieldCheck
                              className="size-4"
                              aria-hidden="true"
                            />
                          </span>
                          <div>
                            <p className="text-sm font-semibold">
                              Human decision
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Approval creates a draft invoice only. Submission
                              remains a separate workflow.
                            </p>
                          </div>
                        </div>
                        <div className="space-y-7 p-4 sm:p-5">
                          {/* Claiming is optional: deciding straight from
                            "extracted" stays possible (solo-operator fast
                            path). A claim only marks the case as actively
                            being reviewed so a second operator doesn't start
                            the same work. */}
                          {selected.status === "extracted" &&
                            !selected.claimedBy && (
                              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/25 p-3">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() =>
                                    claimCase.mutate({ id: selected.id })
                                  }
                                  disabled={claimCase.isPending}
                                  data-testid="button-claim-case"
                                >
                                  <Clock3
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                  {claimCase.isPending
                                    ? "Claiming…"
                                    : "Claim for review"}
                                </Button>
                                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                                  Optional — deciding below works without
                                  claiming.
                                </p>
                              </div>
                            )}
                          {selected.status === "in_review" && (
                            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                              <span
                                className={pillClasses("amber")}
                                data-testid="badge-claimed"
                              >
                                Claimed by {shortActor(selected.claimedBy)} ·{" "}
                                {relativeTime(selected.claimedAt)}
                              </span>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  releaseCase.mutate({ id: selected.id })
                                }
                                disabled={releaseCase.isPending}
                                data-testid="button-release-case"
                              >
                                {releaseCase.isPending
                                  ? "Releasing…"
                                  : "Release"}
                              </Button>
                            </div>
                          )}
                          <section className="space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="grid size-6 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                                1
                              </span>
                              <p className="text-sm font-semibold">
                                Match parties
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              <div className="space-y-1">
                                <Label>Firm</Label>
                                <Select
                                  value={form.firmId}
                                  onValueChange={(v) =>
                                    setForm({ ...form, firmId: v })
                                  }
                                >
                                  <SelectTrigger data-testid="select-firm">
                                    <SelectValue placeholder="Choose firm" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {(firms ?? []).map((f) => (
                                      <SelectItem key={f.id} value={f.id}>
                                        {f.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1">
                                <Label>Supplier party</Label>
                                <Select
                                  value={form.supplierPartyId}
                                  onValueChange={(v) =>
                                    setForm({ ...form, supplierPartyId: v })
                                  }
                                >
                                  <SelectTrigger data-testid="select-supplier">
                                    <SelectValue placeholder="Choose supplier" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {(parties ?? []).map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.legalName}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <PartySuggestionChips
                                  suggestions={partySuggestions?.supplier ?? []}
                                  value={form.supplierPartyId}
                                  onPick={(partyId) =>
                                    setForm({
                                      ...form,
                                      supplierPartyId: partyId,
                                    })
                                  }
                                  testId="suggestions-supplier"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label>Buyer party</Label>
                                <Select
                                  value={form.buyerPartyId}
                                  onValueChange={(v) =>
                                    setForm({ ...form, buyerPartyId: v })
                                  }
                                >
                                  <SelectTrigger data-testid="select-buyer">
                                    <SelectValue placeholder="Choose buyer" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {(parties ?? []).map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.legalName}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <PartySuggestionChips
                                  suggestions={partySuggestions?.buyer ?? []}
                                  value={form.buyerPartyId}
                                  onPick={(partyId) =>
                                    setForm({ ...form, buyerPartyId: partyId })
                                  }
                                  testId="suggestions-buyer"
                                />
                              </div>
                            </div>
                          </section>
                          <section className="space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="grid size-6 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                                2
                              </span>
                              <p className="text-sm font-semibold">
                                Confirm invoice details
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                              <div className="space-y-1">
                                <Label htmlFor="apr-number">
                                  Invoice number
                                </Label>
                                <Input
                                  id="apr-number"
                                  value={form.invoiceNumber}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      invoiceNumber: e.target.value,
                                    })
                                  }
                                  data-testid="input-approve-number"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="apr-issue">Issue date</Label>
                                <Input
                                  id="apr-issue"
                                  type="date"
                                  value={form.issueDate}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      issueDate: e.target.value,
                                    })
                                  }
                                  data-testid="input-approve-issue-date"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="apr-due">Due date</Label>
                                <Input
                                  id="apr-due"
                                  type="date"
                                  value={form.dueDate}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      dueDate: e.target.value,
                                    })
                                  }
                                  data-testid="input-approve-due-date"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label>Category</Label>
                                <Select
                                  value={form.category}
                                  onValueChange={(v) =>
                                    setForm({
                                      ...form,
                                      category:
                                        v as ClerkCaseDecisionInputCategory,
                                    })
                                  }
                                >
                                  <SelectTrigger data-testid="select-category">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {CATEGORIES.map((c) => (
                                      <SelectItem key={c} value={c}>
                                        {c.toUpperCase()}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          </section>
                          <section className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="grid size-6 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                                  3
                                </span>
                                <p className="text-sm font-semibold">
                                  Review line items
                                </p>
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {form.lines.length} lines
                              </span>
                            </div>
                            <div className="overflow-hidden rounded-lg border">
                              <div className="hidden grid-cols-[minmax(0,1fr)_5.5rem_8rem_5.5rem] gap-3 bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground sm:grid">
                                <span>Description</span>
                                <span>Quantity</span>
                                <span>Unit price</span>
                                <span>VAT %</span>
                              </div>
                              {form.lines.map((line, i) => (
                                <div
                                  key={i}
                                  className="grid grid-cols-2 gap-3 border-t p-3 sm:grid-cols-[minmax(0,1fr)_5.5rem_8rem_5.5rem] sm:items-end"
                                  data-testid={`row-line-${i}`}
                                >
                                  <div className="col-span-2 space-y-1 sm:col-span-1">
                                    <Label className="text-xs sm:sr-only">
                                      Description
                                    </Label>
                                    <Input
                                      aria-label={`Line ${i + 1} description`}
                                      placeholder="Description"
                                      value={line.description}
                                      onChange={(e) =>
                                        setLine(i, {
                                          description: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs sm:sr-only">
                                      Quantity
                                    </Label>
                                    <Input
                                      aria-label={`Line ${i + 1} quantity`}
                                      placeholder="Qty"
                                      value={line.quantity}
                                      onChange={(e) =>
                                        setLine(i, { quantity: e.target.value })
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs sm:sr-only">
                                      Unit price
                                    </Label>
                                    <Input
                                      aria-label={`Line ${i + 1} unit price`}
                                      placeholder="Unit price"
                                      value={line.unitPrice}
                                      onChange={(e) =>
                                        setLine(i, {
                                          unitPrice: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="col-span-2 space-y-1 sm:col-span-1">
                                    <Label className="text-xs sm:sr-only">
                                      VAT %
                                    </Label>
                                    <Input
                                      aria-label={`Line ${i + 1} VAT percentage`}
                                      placeholder="VAT %"
                                      value={line.vatRate}
                                      onChange={(e) =>
                                        setLine(i, { vatRate: e.target.value })
                                      }
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                          <section className="space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="grid size-6 place-items-center rounded-full bg-slate-900 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                                4
                              </span>
                              <p className="text-sm font-semibold">
                                Record decision
                              </p>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="apr-reason">
                                Reason (required to reject or escalate)
                              </Label>
                              <Textarea
                                id="apr-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={2}
                                data-testid="input-decision-reason"
                              />
                            </div>
                            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap">
                              <Button
                                className="w-full sm:w-auto"
                                onClick={() =>
                                  decideCase.mutate({
                                    id: selected.id,
                                    data: {
                                      action: "approve",
                                      firmId: form.firmId,
                                      supplierPartyId: form.supplierPartyId,
                                      buyerPartyId: form.buyerPartyId,
                                      invoiceNumber: form.invoiceNumber.trim(),
                                      issueDate: form.issueDate,
                                      dueDate: form.dueDate || null,
                                      currency: form.currency,
                                      category: form.category,
                                      lines: form.lines.map((l) => ({
                                        ...l,
                                        vatRate: vatFractionFromPercent(
                                          l.vatRate,
                                        ),
                                      })),
                                      reason: reason || null,
                                    },
                                  })
                                }
                                disabled={
                                  approveDisabled || decideCase.isPending
                                }
                                data-testid="button-approve-case"
                              >
                                <CheckCircle2
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                Approve draft
                              </Button>
                              <Button
                                className="w-full sm:w-auto"
                                variant="destructive"
                                onClick={() =>
                                  decideCase.mutate({
                                    id: selected.id,
                                    data: { action: "reject", reason },
                                  })
                                }
                                disabled={
                                  !reason.trim() || decideCase.isPending
                                }
                                data-testid="button-reject-case"
                              >
                                <CircleX
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                Reject
                              </Button>
                              <Button
                                className="w-full sm:w-auto"
                                variant="secondary"
                                onClick={() =>
                                  decideCase.mutate({
                                    id: selected.id,
                                    data: { action: "escalate", reason },
                                  })
                                }
                                disabled={
                                  !reason.trim() || decideCase.isPending
                                }
                                data-testid="button-escalate-case"
                              >
                                <ArrowUpRight
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                Escalate
                              </Button>
                            </div>
                          </section>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ask" className="mt-0">
          <AskPanel
            question={question}
            onQuestionChange={setQuestion}
            onAsk={() => ask.mutate({ data: { question } })}
            isPending={ask.isPending}
            answer={ask.data?.answer}
          />
        </TabsContent>

        <TabsContent value="health" className="mt-0">
          <HealthPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
