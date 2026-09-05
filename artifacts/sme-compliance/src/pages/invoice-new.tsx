import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  createInvoice,
  getCreateInvoiceMutationOptions,
  getDraftInvoiceWithClerkMutationOptions,
  draftInvoiceWithClerk,
  useListErrorCatalogue,
  useListLineItemSuggestions,
  getListInvoicesQueryKey,
  type InvoiceInputWhtCategory,
  type InvoiceLineInput,
  type LineItemSuggestion,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHT_CATEGORY_LABELS } from "@workspace/format/wht-copy";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { PageHeader } from "@/components/page-header";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
  ReadinessList,
  type ReadinessStep,
} from "@workspace/web-ui";
import { RequireClientScope } from "@/components/require-client-scope";
import { AddCustomerDialog } from "@/components/add-customer-dialog";
import {
  CustomerDirectoryPicker,
  useDirectoryCustomer,
} from "@/components/customer-directory-picker";
import { InvoiceDraftControls } from "@/components/invoice-draft-controls";
import { useInvoiceDrafts } from "@/lib/use-invoice-drafts";
import { useSessionWork, type SessionWork } from "@/lib/use-session-work";
import type { InvoiceDraftSession } from "@/lib/invoice-draft-session";
import { isDefinitiveFirstRejection } from "@/lib/invoice-submission";
import { FieldError, invalidClass } from "@/components/field-error";
import { LineItemRow } from "@/components/line-item-row";
import { formatAmount, formatNaira } from "@/lib/format";
import { serverErrorMessage } from "@/lib/errors";
import { handleClerkGatewayError } from "@/lib/clerk";
import {
  type LineDraft,
  VAT_STANDARD,
  emptyLine,
  draftHasWork,
  lineTotals,
  invoiceLineErrors,
  toInvoiceLineInputs,
  updateLineAt,
} from "@/lib/invoice-lines";
import {
  DRAFT_KEY,
  draftStorageKey,
  type DraftState,
} from "@/lib/invoice-draft";
import { Plus, ShieldCheck, Sparkles } from "lucide-react";

export { DRAFT_KEY, draftStorageKey };
export type { DraftState };

// The lawful set the rails accept for e-invoicing; NGN leads and is the
// default — a foreign currency additionally wants an exchange rate so the
// naira-equivalent VAT can be computed server-side.
export const CURRENCIES = ["NGN", "USD", "EUR", "GBP"] as const;

// The Radix select can't carry an empty-string item value, so the "No WHT"
// option rides a sentinel that maps back to "" in the draft.
const NO_WHT = "none";

export function InvoiceNew() {
  usePageTitle("New invoice");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data: catalogue } = useListErrorCatalogue();
  const drafts = useInvoiceDrafts();
  const { draft, setDraft } = drafts;
  const submission = drafts.state.submission;
  const locked = !!submission;
  const creating = useRef<SessionWork | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const operationKey = operationSessionKey(me);
  const captureWork = useSessionWork(
    operationKey ? `${operationKey}:${drafts.id}` : null,
  );
  useEffect(() => {
    creating.current = null;
    setSubmitting(false);
  }, [drafts.session]);
  const create = useMutation({
    mutationKey: getCreateInvoiceMutationOptions().mutationKey,
    mutationFn: async ({
      data,
      work,
      journalKey,
      session,
    }: {
      data: Parameters<typeof createInvoice>[0];
      work: SessionWork;
      journalKey: string | null;
      session: InvoiceDraftSession;
    }) => {
      work.check();
      const prepared = await session.prepareSubmission(data, work.check);
      work.check();
      if (prepared.submission.status !== "pending")
        throw new Error(
          "This invoice request cannot be submitted again. Reconcile its existing result.",
        );
      const intent = prepared.submission;
      const operation = beginOperation(journalKey, {
        title: "Create invoice",
        kind: "invoice",
        route: `/invoices/new?draft=${work.id}`,
        command: "invoice.create",
        idempotencyKey: intent.key,
      });
      try {
        work.check();
        const result = await createInvoice(structuredClone(intent.body), {
          headers: { "X-Idempotency-Key": intent.key },
          signal: work.signal,
        });
        work.check();
        session.confirmSubmission(result.invoice.id);
        updateOperation(journalKey, operation?.id, {
          status: "succeeded",
          savedSummary: "1 invoice draft created.",
        });
        return result;
      } catch (error) {
        if (!work.current()) throw error;
        const rejected =
          prepared.firstDispatch && isDefinitiveFirstRejection(error);
        if (rejected) session.rejectSubmission();
        updateOperation(journalKey, operation?.id, {
          status: rejected ? "failed" : "partial",
          savedSummary: rejected
            ? "The server rejected this request before creation. Correct the invoice and retry."
            : "We could not confirm whether your invoice was created. Use Retry original invoice to check safely without creating a duplicate.",
        });
        throw error;
      }
    },
  });

  const tinGuidance = useMemo(() => {
    const entry = (catalogue || []).find((c) => c.code === "MBS_INVALID_TIN");
    return (
      entry?.fix ??
      "Add the customer's Tax Identification Number before submitting — FIRS rejects B2B invoices without a valid customer TIN."
    );
  }, [catalogue]);

  const [showErrors, setShowErrors] = useState(false);
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);

  // Frequent items (line-item memory): mined server-side from this client's
  // own invoices. Clicking a chip appends a prefilled line — a suggestion the
  // user edits like any other; nothing is created until they save.
  const { data: frequentItems } = useListLineItemSuggestions();
  const addFrequentItem = (item: LineItemSuggestion) => {
    const line = {
      description: item.description,
      quantity: "1",
      unitPrice: item.medianUnitPrice,
      // The form offers the two lawful choices; anything else defaults to
      // standard for the user to see (same rule as the Clerk draft path).
      vatRate: Number(item.vatRate) === 0 ? "0" : VAT_STANDARD,
    };
    setDraft((d) => {
      // Fill the trailing empty line if there is one; append otherwise.
      const last = d.lines[d.lines.length - 1];
      const lastIsEmpty =
        last && !last.description.trim() && !Number(last.unitPrice);
      return {
        ...d,
        lines: lastIsEmpty
          ? [...d.lines.slice(0, -1), line]
          : [...d.lines, line],
      };
    });
  };

  // "Draft with Clerk" (idea #7): one sentence prefills the SAME form below —
  // Clerk proposes, the client reviews and saves through the ordinary create
  // path; nothing exists until they click "Create invoice".
  // PL-02 gate, mirroring the dashboard's Clerk surfaces: the card is absent
  // while the clerk_ai feature is dark.
  const clerkLit = !!me?.features.includes("clerk_ai");
  const clerkDraft = useMutation({
    mutationKey: getDraftInvoiceWithClerkMutationOptions().mutationKey,
    mutationFn: async ({
      data,
      work,
    }: {
      data: Parameters<typeof draftInvoiceWithClerk>[0];
      work: SessionWork;
    }) => {
      work.check();
      const result = await draftInvoiceWithClerk(data, { signal: work.signal });
      work.check();
      return result;
    },
  });
  const [clerkText, setClerkText] = useState("");
  const [clerkNote, setClerkNote] = useState<string | null>(null);

  const draftWithClerk = async () => {
    const startedSession = drafts.session;
    if (startedSession.refreshSubmission()) return;
    const startedDraft = draft;
    const work = captureWork(drafts.id, startedSession.captureLifecycle());
    if (!work.current()) {
      work.close();
      return;
    }
    try {
      work.check();
      const res = await clerkDraft.mutateAsync({
        data: { text: clerkText },
        work,
      });
      work.check();
      if (
        drafts.latest.current !== startedSession ||
        startedSession.state.draft !== startedDraft
      ) {
        setClerkNote(
          "Your draft changed while Clerk was working. The suggestion was not applied.",
        );
        return;
      }
      const p = res.proposal;
      // Buyer identity is only ever a suggestion: preselect the top match if
      // it is a customer the picker actually offers; otherwise say what Clerk
      // read so the user can pick or add the customer themselves.
      const top = res.buyerSuggestions[0];
      const matchedBuyerId = top?.partyId ?? "";
      setDraft((d) => ({
        ...d,
        invoiceNumber: p.invoiceNumber ?? d.invoiceNumber,
        buyerPartyId: matchedBuyerId || d.buyerPartyId,
        issueDate: p.issueDate ?? d.issueDate,
        dueDate: p.dueDate ?? d.dueDate,
        lines:
          p.lines.length > 0
            ? p.lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice ?? "",
                // The form offers the two lawful choices; anything else the
                // instruction implied defaults to standard for the user to see.
                vatRate: l.vatRate === "0" ? "0" : VAT_STANDARD,
              }))
            : d.lines,
      }));
      setClerkNote(
        p.buyerName && !matchedBuyerId
          ? `Clerk read the customer as "${p.buyerName}" — pick or add them below, then check every field.`
          : "Prefilled from your instruction — check every field before saving.",
      );
    } catch (e) {
      if (!work.current()) return;
      handleClerkGatewayError(e, {
        onDisabled: () =>
          setClerkNote(
            "Clerk is currently unavailable — fill the form manually.",
          ),
        toast,
        fallbackTitle: "Clerk couldn't draft that",
      });
    } finally {
      work.close();
    }
  };

  // Discard with an escape hatch (user control and freedom): the cleared
  // draft is held in the closure and one Undo puts it — and its device copy —
  // back exactly as it was. Only offered when the draft carried real work.
  const discardDraft = async () => {
    const stashedDraft = draft;
    const discardedSession = drafts.session;
    const current = discardedSession.captureLifecycle();
    try {
      if (!(await discardedSession.discard()) || !current()) return;
    } catch (error) {
      if (!current()) return;
      toast({
        title: "Draft was not discarded",
        description: serverErrorMessage(error),
        variant: "destructive",
      });
      return;
    }
    if (drafts.latest.current !== discardedSession) return;
    drafts.newDraft();
    setShowErrors(false);
    if (!draftHasWork(stashedDraft)) return;
    toast({
      title: "Draft discarded",
      description:
        "Your unfinished invoice was discarded from your account and this tab.",
      action: (
        <ToastAction
          altText="Undo discarding the draft"
          data-testid="button-undo-discard"
          onClick={() => {
            drafts.newDraft(stashedDraft);
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  };

  const { data: selectedBuyer } = useDirectoryCustomer(draft.buyerPartyId);

  const totals = lineTotals(draft.lines);

  const errors: Record<string, string> = {};
  if (!draft.invoiceNumber.trim())
    errors.invoiceNumber = "Invoice number is required.";
  if (!draft.buyerPartyId) errors.buyerPartyId = "Select a customer.";
  // A missing buyer TIN never blocks a DRAFT — the note under the picker
  // warns, the checklist stays unchecked, and the server refuses submission
  // for stamping until the TIN exists (canonical validation).
  if (!draft.issueDate) errors.issueDate = "Issue date is required.";
  draft.lines.forEach((l, i) => {
    const lineErrors = invoiceLineErrors(l);
    if (lineErrors.description)
      errors[`line-${i}-desc`] = lineErrors.description;
    if (lineErrors.quantity) errors[`line-${i}-qty`] = lineErrors.quantity;
    if (lineErrors.unitPrice) errors[`line-${i}-price`] = lineErrors.unitPrice;
  });
  const isValid = Object.keys(errors).length === 0;

  // Which DOM element carries each validation error, in visual order — used to
  // scroll/focus the first invalid field on a failed submit.
  const errorFieldIds = (): string[] => {
    const ids: string[] = [];
    if (errors.invoiceNumber) ids.push("invoice-number");
    if (errors.buyerPartyId) ids.push("buyer-select");
    if (errors.issueDate) ids.push("issue-date");
    draft.lines.forEach((_, i) => {
      if (errors[`line-${i}-desc`]) ids.push(`line-${i}-description`);
      if (errors[`line-${i}-qty`]) ids.push(`line-${i}-quantity`);
      if (errors[`line-${i}-price`]) ids.push(`line-${i}-unit-price`);
    });
    return ids;
  };

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft((d) => ({ ...d, lines: updateLineAt(d.lines, i, patch) }));

  const submit = async () => {
    if (
      creating.current ||
      (!submission &&
        (drafts.state.status === "loading" ||
          drafts.state.status === "conflict"))
    )
      return;
    setShowErrors(true);
    if (!submission && !isValid) {
      const first = errorFieldIds()[0];
      if (first) {
        const el = document.getElementById(first);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement | null)?.focus({ preventScroll: true });
      }
      return;
    }
    if (!me?.clientPartyId) return;
    const submittedSession = drafts.session;
    const work = captureWork(drafts.id, submittedSession.captureLifecycle());
    if (!work.current()) {
      work.close();
      return;
    }
    const original = submittedSession.refreshSubmission();
    if (original?.status === "succeeded") {
      work.close();
      navigate(`/invoices/${original.invoiceId}`);
      return;
    }
    if (original?.status === "blocked") {
      work.close();
      return;
    }
    creating.current = work;
    setSubmitting(true);
    const current = work.current;
    let commandStarted = false;
    try {
      const saved =
        original?.status === "pending" || (await submittedSession.save());
      if (
        !current() ||
        !submittedSession.isActive() ||
        drafts.latest.current !== submittedSession
      )
        return;
      if (!saved) {
        toast({
          title: "Invoice not sent",
          description:
            "Wait for this draft to save, or review the conflicting account version, before creating the invoice.",
          variant: "destructive",
        });
        return;
      }
      if (submittedSession.state.status === "conflict") return;
      const lines: InvoiceLineInput[] = toInvoiceLineInputs(draft.lines);
      const fxRate = draft.fxRateToNgn.trim();
      commandStarted = true;
      const res = await create.mutateAsync({
        work,
        journalKey: operationKey,
        session: submittedSession,
        data:
          original?.status === "pending"
            ? original.body
            : {
                supplierPartyId: me.clientPartyId,
                buyerPartyId: draft.buyerPartyId,
                invoiceNumber: draft.invoiceNumber.trim(),
                currency: draft.currency || "NGN",
                // The rate only makes sense on a foreign-currency invoice, and an
                // empty field is omitted, never sent as "".
                ...(draft.currency !== "NGN" && fxRate
                  ? { fxRateToNgn: fxRate }
                  : {}),
                issueDate: draft.issueDate,
                dueDate: draft.dueDate || undefined,
                // Only a real, human-picked category travels; "" (No WHT) is
                // omitted, never sent.
                ...(draft.whtCategory
                  ? {
                      whtCategory: draft.whtCategory as InvoiceInputWhtCategory,
                    }
                  : {}),
                lines,
              },
      });
      if (!current()) return;
      try {
        await submittedSession.discard();
      } catch {
        submittedSession.complete();
      }
      if (!current()) return;
      // Not awaited: a background refetch rejection must not surface as a false
      // "could not create invoice" error after the save already succeeded.
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      toast({ title: "Invoice created", description: "Saved to your vault." });
      if (drafts.latest.current === submittedSession)
        navigate(`/invoices/${res.invoice.id}`);
    } catch (e) {
      if (!current()) return;
      const uncertain = commandStarted && !!submittedSession.state.submission;
      toast({
        title: uncertain
          ? "Invoice creation not confirmed"
          : "Could not create invoice",
        description: uncertain
          ? "We could not confirm whether your invoice was created. Select Retry original invoice to check safely. Do not start a replacement invoice."
          : serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      if (creating.current === work) {
        creating.current = null;
        if (work.current()) setSubmitting(false);
      }
      work.close();
    }
  };

  // The guided rail (R70): each step names its form section, links to it,
  // and says what is still missing. The TIN row is "attention", never
  // blocking — a draft without a buyer TIN is lawful; stamping is not.
  const linesComplete =
    draft.lines.length > 0 &&
    draft.lines.every(
      (line) => Object.keys(invoiceLineErrors(line)).length === 0,
    );
  const vatLawful = draft.lines.every(
    (l) => Number(l.vatRate) === 0.075 || Number(l.vatRate) === 0,
  );
  const checklist: ReadinessStep[] = [
    {
      id: "invoice-number",
      label: "Invoice number",
      state: draft.invoiceNumber.trim() ? "done" : "todo",
      href: "#invoice-details",
    },
    {
      id: "customer",
      label: "Customer selected",
      state: draft.buyerPartyId ? "done" : "todo",
      href: "#invoice-details",
    },
    {
      id: "customer-tin",
      label: "Customer has a TIN",
      state: selectedBuyer?.tin
        ? "done"
        : draft.buyerPartyId
          ? "attention"
          : "todo",
      href: "#invoice-details",
      detail:
        draft.buyerPartyId && !selectedBuyer?.tin
          ? "Needed before stamping; a draft can still be saved."
          : undefined,
    },
    {
      id: "line-items",
      label: "Line items complete",
      state: linesComplete ? "done" : "todo",
      href: "#invoice-lines",
      detail: linesComplete
        ? undefined
        : "Every line needs a description, a quantity above zero and a valid unit price. Zero-priced items are allowed.",
    },
    {
      id: "vat",
      label: "VAT at 7.5% (or exempt)",
      state: vatLawful ? "done" : "attention",
      href: "#invoice-lines",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="New invoice"
        description="We check it against FIRS rules as you type."
      />
      <InvoiceDraftControls
        controller={drafts}
        disabled={submitting || (locked && submission.status !== "succeeded")}
        onDiscard={() => void discardDraft()}
      />
      {submission && (
        <section
          role="status"
          aria-label="Invoice request recovery"
          className="space-y-2 border-y py-3"
        >
          <p className="text-sm">
            {submission.status === "succeeded"
              ? "This invoice was already created."
              : submission.status === "blocked"
                ? "The original request cannot be read on this device. Check account activity before creating a replacement invoice; it could duplicate a completed invoice."
                : "We could not confirm whether this invoice was created. Your customer and amounts are kept on this device. Select Retry original invoice to check safely without creating a duplicate."}
          </p>
          {submission.status !== "blocked" && (
            <Button onClick={submit} disabled={submitting}>
              {submitting
                ? "Checking invoice..."
                : submission.status === "succeeded"
                  ? "View created invoice"
                  : "Retry original invoice"}
            </Button>
          )}
        </section>
      )}

      <RequireClientScope thing="invoice form">
        <AddCustomerDialog
          open={addCustomerOpen}
          onOpenChange={setAddCustomerOpen}
          onCreated={(party) =>
            setDraft((d) => ({ ...d, buyerPartyId: party.id }))
          }
        />
        <fieldset
          disabled={submitting || locked || drafts.state.status === "loading"}
          className="grid min-w-0 gap-6 lg:grid-cols-3"
        >
          <div className="lg:col-span-2 space-y-6">
            {clerkLit && (
              <Card className="border-violet-200 dark:border-violet-900">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles
                      className="w-4 h-4 text-violet-600 dark:text-violet-400"
                      aria-hidden="true"
                    />
                    Draft with Clerk
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Label htmlFor="clerk-draft-text" className="sr-only">
                    Describe the invoice
                  </Label>
                  <Textarea
                    id="clerk-draft-text"
                    value={clerkText}
                    onChange={(e) => setClerkText(e.target.value)}
                    rows={2}
                    placeholder='e.g. "Invoice Adaeze Foods ₦150,000 for June deliveries, 7.5% VAT"'
                    data-testid="input-clerk-draft"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Clerk prefills the form below — you review and save;
                      nothing is created until you do.
                    </p>
                    <Button
                      variant="outline"
                      onClick={draftWithClerk}
                      disabled={
                        clerkText.trim().length < 5 || clerkDraft.isPending
                      }
                      data-testid="button-clerk-draft"
                    >
                      {clerkDraft.isPending ? "Drafting…" : "Draft it"}
                    </Button>
                  </div>
                  <p
                    role="status"
                    className="text-xs text-violet-800 dark:text-violet-300"
                    data-testid="text-clerk-note"
                  >
                    {clerkNote}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card id="invoice-details" className="scroll-mt-24">
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="invoice-number">Invoice number</Label>
                  <Input
                    id="invoice-number"
                    value={draft.invoiceNumber}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))
                    }
                    placeholder="INV-1006"
                    aria-invalid={showErrors && !!errors.invoiceNumber}
                    aria-describedby={
                      showErrors && errors.invoiceNumber
                        ? "invoice-number-error"
                        : undefined
                    }
                    className={invalidClass(
                      showErrors && !!errors.invoiceNumber,
                    )}
                  />
                  {showErrors && errors.invoiceNumber && (
                    <FieldError id="invoice-number-error">
                      {errors.invoiceNumber}
                    </FieldError>
                  )}
                </div>
                <div>
                  <Label htmlFor="buyer-select">Customer</Label>
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <CustomerDirectoryPicker
                        id="buyer-select"
                        value={draft.buyerPartyId}
                        onChange={(buyerPartyId) =>
                          setDraft((d) => ({ ...d, buyerPartyId }))
                        }
                        excludeId={me?.clientPartyId ?? undefined}
                        invalid={showErrors && !!errors.buyerPartyId}
                        describedBy={
                          showErrors && errors.buyerPartyId
                            ? "buyer-select-error"
                            : selectedBuyer && !selectedBuyer.tin
                              ? "buyer-tin-note"
                              : undefined
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setAddCustomerOpen(true)}
                      data-testid="button-add-customer"
                    >
                      <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                      Add customer
                    </Button>
                  </div>
                  {showErrors && errors.buyerPartyId && (
                    <FieldError id="buyer-select-error">
                      {errors.buyerPartyId}
                    </FieldError>
                  )}
                  {selectedBuyer && !selectedBuyer.tin && (
                    <p
                      id="buyer-tin-note"
                      className="text-sm mt-1 text-amber-700 dark:text-amber-400"
                    >
                      {tinGuidance} You can still save this invoice as a draft —
                      it cannot be submitted for stamping until the TIN is
                      added.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="issue-date">Issue date</Label>
                    <Input
                      id="issue-date"
                      type="date"
                      value={draft.issueDate}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, issueDate: e.target.value }))
                      }
                      aria-invalid={showErrors && !!errors.issueDate}
                      aria-describedby={
                        showErrors && errors.issueDate
                          ? "issue-date-error"
                          : undefined
                      }
                      className={invalidClass(showErrors && !!errors.issueDate)}
                    />
                    {showErrors && errors.issueDate && (
                      <FieldError id="issue-date-error">
                        {errors.issueDate}
                      </FieldError>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="due-date">Due date (optional)</Label>
                    <Input
                      id="due-date"
                      type="date"
                      value={draft.dueDate}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, dueDate: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="currency-select">Currency</Label>
                    <select
                      id="currency-select"
                      value={draft.currency}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, currency: e.target.value }))
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="select-currency"
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  {draft.currency !== "NGN" && (
                    <div>
                      <Label htmlFor="fx-rate">
                        Exchange rate (₦ per unit)
                      </Label>
                      <Input
                        id="fx-rate"
                        inputMode="decimal"
                        value={draft.fxRateToNgn}
                        placeholder="e.g. 1650.00"
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            fxRateToNgn: e.target.value,
                          }))
                        }
                        data-testid="input-fx-rate"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Used to fold this invoice into your naira VAT position.
                      </p>
                    </div>
                  )}
                </div>
                <div>
                  <Label htmlFor="wht-category-select">WHT category</Label>
                  {/* A human picks the category — nothing is ever
                    pre-selected; "No WHT" is the default and omits the
                    field from the payload. The % in each label is wording
                    from the shared catalogue, not arithmetic. */}
                  <Select
                    value={draft.whtCategory || NO_WHT}
                    onValueChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        whtCategory: v === NO_WHT ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger
                      id="wht-category-select"
                      data-testid="select-wht-category"
                    >
                      <SelectValue placeholder="No WHT" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_WHT}>No WHT</SelectItem>
                      {Object.entries(WHT_CATEGORY_LABELS).map(
                        ([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    If your customer withholds tax on this invoice, pick the
                    deduction type — the customer owes you a credit note for it.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card id="invoice-lines" className="scroll-mt-24">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Line items</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      lines: [...d.lines, emptyLine()],
                    }))
                  }
                >
                  <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {(frequentItems ?? []).length > 0 && (
                  <div className="space-y-1.5" data-testid="frequent-items">
                    <p className="text-xs text-muted-foreground">
                      Frequent items — from your own invoices; click to add a
                      prefilled line, then check the price.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(frequentItems ?? []).slice(0, 8).map((item) => (
                        <Button
                          key={item.key}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => addFrequentItem(item)}
                          data-testid={`frequent-item-${item.key}`}
                        >
                          {item.description} ·{" "}
                          {formatNaira(item.medianUnitPrice)}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {draft.lines.map((l, i) => (
                  <LineItemRow
                    key={i}
                    index={i}
                    line={l}
                    onPatch={(patch) => setLine(i, patch)}
                    removable={draft.lines.length > 1}
                    onRemove={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.filter((_, idx) => idx !== i),
                      }))
                    }
                    errors={{
                      description: showErrors
                        ? errors[`line-${i}-desc`]
                        : undefined,
                      quantity: showErrors
                        ? errors[`line-${i}-qty`]
                        : undefined,
                      unitPrice: showErrors
                        ? errors[`line-${i}-price`]
                        : undefined,
                    }}
                    showTotal
                    currency={draft.currency}
                  />
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="lg:sticky lg:top-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <span className="mi-card-icon">
                    <ShieldCheck aria-hidden="true" />
                  </span>
                  Ready to create?
                </CardTitle>
                <CardDescription>
                  Checked against FIRS rules as you type.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ReadinessList steps={checklist} />
                <div className="border-t pt-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Net</span>
                    <span className="tabular-nums">
                      {formatAmount(totals.net, draft.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">VAT</span>
                    <span className="tabular-nums">
                      {formatAmount(totals.vat, draft.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">
                      {formatAmount(totals.total, draft.currency)}
                    </span>
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={submit}
                  disabled={submitting || drafts.state.status === "conflict"}
                >
                  {submitting ? "Saving…" : "Create invoice"}
                </Button>
                {showErrors && !isValid && (
                  <p
                    className="text-sm text-destructive text-center"
                    role="alert"
                  >
                    Fix the highlighted fields to continue.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </fieldset>
      </RequireClientScope>
    </div>
  );
}
