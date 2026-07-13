import { useEffect, useMemo, useState } from "react";
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
  Bot,
  FileUp,
  MessageCircleQuestion,
  Mic,
  Plus,
  PowerOff,
  ShieldCheck,
} from "lucide-react";

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
    confidence >= 0.9 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400 font-medium";
  return <span className={`text-xs tabular-nums ${tone}`}>{pct}%</span>;
}

export function ClerkWorkspace() {
  usePageTitle("Clerk");
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
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Bot className="w-6 h-6" aria-hidden="true" /> Clerk
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          A shadow copilot for operators. It reads documents and quotes the
          claims register — it never files anything with the tax authority.
        </p>
      </div>

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

      <Tabs defaultValue="capture">
        <TabsList>
          <TabsTrigger value="capture" data-testid="tab-capture">
            <FileUp className="w-4 h-4 mr-1" aria-hidden="true" /> Document
            capture
          </TabsTrigger>
          <TabsTrigger value="ask" data-testid="tab-ask">
            <MessageCircleQuestion className="w-4 h-4 mr-1" aria-hidden="true" />{" "}
            Ask Clerk
          </TabsTrigger>
          <TabsTrigger value="health" data-testid="tab-health">
            <Activity className="w-4 h-4 mr-1" aria-hidden="true" /> Health
          </TabsTrigger>
        </TabsList>

        <TabsContent value="capture" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Cases</CardTitle>
                <Button
                  size="sm"
                  onClick={() => setCaptureOpen((o) => !o)}
                  data-testid="button-new-capture"
                >
                  <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {captureOpen && (
                  <div className="border rounded-md p-3 space-y-2">
                    <Label htmlFor="capture-file">
                      Invoice document (PDF or photo)
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
                    <Label htmlFor="capture-voice">
                      or a voice note (max 5 MB)
                    </Label>
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
                          variant={isRecording ? "destructive" : "secondary"}
                          onClick={isRecording ? stopRecording : startRecording}
                          disabled={
                            createCase.isPending ||
                            (!isRecording && captureFile != null)
                          }
                          data-testid="button-record-voice"
                        >
                          <Mic className="w-4 h-4 mr-1" aria-hidden="true" />
                          {isRecording ? "Stop recording" : "Record voice note"}
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
                    <p className="text-xs text-muted-foreground">
                      or paste the invoice text:
                    </p>
                    <Textarea
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
                    <Button
                      className="w-full"
                      onClick={submitCapture}
                      disabled={
                        createCase.isPending ||
                        (!captureFile &&
                          !captureVoice &&
                          captureText.trim().length < 10)
                      }
                      data-testid="button-run-capture"
                    >
                      {createCase.isPending
                        ? captureVoice
                          ? "Transcribing…"
                          : "Reading…"
                        : "Read with Clerk"}
                    </Button>
                    {pendingDuplicate && (
                      <Alert data-testid="banner-duplicate-source">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
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
                )}
                {/* The query is already extraction-only (kind param), so no
                    client-side kind filter is needed here anymore. */}
                {sortedCases.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No documents read yet.
                  </p>
                ) : (
                  <div className="divide-y">
                    {sortedCases.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={`w-full text-left flex items-center gap-2 py-2 -mx-2 px-2 rounded-md hover:bg-muted/50 ${
                          selectedId === c.id ? "bg-muted/60" : ""
                        }`}
                        data-testid={`row-case-${c.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {c.sourceName ?? "Untitled"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(c.createdAt)}
                          </p>
                        </div>
                        {c.status === "in_review" && (
                          <span
                            className="text-[10px] uppercase text-muted-foreground"
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
                          {c.status.replace("_", " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {(hasMoreCases || loadingMoreCases) && (
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
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">
                  {selected
                    ? (selected.sourceName ?? "Case detail")
                    : "Case detail"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selected ? (
                  <p className="text-sm text-muted-foreground">
                    Pick a case on the left, or read a new document.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span
                        className={pillClasses(
                          STATUS_TONE[selected.status] ?? "slate",
                        )}
                      >
                        {selected.status.replace("_", " ")}
                      </span>
                      {selected.extraction && (
                        <span className="text-xs text-muted-foreground">
                          read by {selected.extraction.model} (
                          {selected.extraction.promptVersion})
                        </span>
                      )}
                    </div>

                    {selected.status === "failed" && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
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
                    )}
                    {selected.status === "escalated" && (
                      <Alert>
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertTitle>Escalated</AlertTitle>
                        <AlertDescription>
                          {selected.decisionReason ??
                            "This case needs a human decision outside the Clerk."}
                        </AlertDescription>
                      </Alert>
                    )}

                    {selected.extraction && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                          Extracted fields — amber rows need checking
                        </p>
                        <div className="border rounded-md divide-y text-sm">
                          {selected.extraction.fields.map((f) => (
                            <div
                              key={f.field}
                              className={`flex items-center gap-2 px-3 py-1.5 ${
                                f.flagged
                                  ? "bg-amber-50 dark:bg-amber-950/40"
                                  : ""
                              }`}
                              data-testid={`row-field-${f.field}`}
                            >
                              <code className="text-xs w-32 shrink-0">
                                {f.field}
                              </code>
                              <span className="flex-1 truncate">
                                {f.value ?? (
                                  <em className="text-muted-foreground">
                                    missing
                                  </em>
                                )}
                              </span>
                              {f.critical && (
                                <span className="text-[10px] uppercase text-muted-foreground">
                                  critical
                                </span>
                              )}
                              <ConfidenceBadge confidence={f.confidence} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selected.status === "approved" &&
                      selected.createdInvoiceId && (
                        <Alert data-testid="banner-draft-created">
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                          <AlertTitle>Draft invoice created</AlertTitle>
                          <AlertDescription>
                            The invoice was created as a DRAFT. It has not been
                            submitted — it follows the normal human submission
                            flow.
                          </AlertDescription>
                        </Alert>
                      )}

                    {form && (
                      <div className="border-t pt-4 space-y-3">
                        <p className="text-sm font-medium">
                          Review and approve — creates a draft invoice only
                        </p>
                        {/* Claiming is optional: deciding straight from
                            "extracted" stays possible (solo-operator fast
                            path). A claim only marks the case as actively
                            being reviewed so a second operator doesn't start
                            the same work. */}
                        {selected.status === "extracted" &&
                          !selected.claimedBy && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  claimCase.mutate({ id: selected.id })
                                }
                                disabled={claimCase.isPending}
                                data-testid="button-claim-case"
                              >
                                {claimCase.isPending
                                  ? "Claiming…"
                                  : "Claim for review"}
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                Optional — deciding below works without
                                claiming.
                              </p>
                            </div>
                          )}
                        {selected.status === "in_review" && (
                          <div className="flex items-center gap-2 flex-wrap">
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
                        <div className="grid sm:grid-cols-3 gap-3">
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
                                setForm({ ...form, supplierPartyId: partyId })
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
                        <div className="grid sm:grid-cols-4 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="apr-number">Invoice number</Label>
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
                                setForm({ ...form, issueDate: e.target.value })
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
                                setForm({ ...form, dueDate: e.target.value })
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
                        <div className="space-y-2">
                          <Label>Lines</Label>
                          {form.lines.map((line, i) => (
                            <div
                              key={i}
                              className="grid grid-cols-12 gap-2"
                              data-testid={`row-line-${i}`}
                            >
                              <Input
                                className="col-span-6"
                                placeholder="Description"
                                value={line.description}
                                onChange={(e) =>
                                  setLine(i, { description: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Qty"
                                value={line.quantity}
                                onChange={(e) =>
                                  setLine(i, { quantity: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Unit price"
                                value={line.unitPrice}
                                onChange={(e) =>
                                  setLine(i, { unitPrice: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="VAT %"
                                value={line.vatRate}
                                onChange={(e) =>
                                  setLine(i, { vatRate: e.target.value })
                                }
                              />
                            </div>
                          ))}
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
                        <div className="flex gap-2 flex-wrap">
                          <Button
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
                                    vatRate: vatFractionFromPercent(l.vatRate),
                                  })),
                                  reason: reason || null,
                                },
                              })
                            }
                            disabled={approveDisabled || decideCase.isPending}
                            data-testid="button-approve-case"
                          >
                            Approve as draft invoice
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "reject", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-reject-case"
                          >
                            Reject
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "escalate", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-escalate-case"
                          >
                            Escalate
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ask" className="mt-4">
          <AskPanel
            question={question}
            onQuestionChange={setQuestion}
            onAsk={() => ask.mutate({ data: { question } })}
            isPending={ask.isPending}
            answer={ask.data?.answer}
          />
        </TabsContent>

        <TabsContent value="health" className="mt-4">
          <HealthPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
