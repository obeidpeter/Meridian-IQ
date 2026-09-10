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
  type InvoiceLineInput,
  type LineItemSuggestion,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
} from "@workspace/web-ui";
import { useDirectoryCustomer } from "@/components/customer-directory-picker";
import { useInvoiceDrafts } from "@/lib/use-invoice-drafts";
import { useSessionWork, type SessionWork } from "@/lib/use-session-work";
import type { InvoiceDraftSession } from "@/lib/invoice-draft-session";
import { isDefinitiveFirstRejection } from "@/lib/invoice-submission";
import { serverErrorMessage } from "@/lib/errors";
import { handleClerkGatewayError } from "@/lib/clerk";
import {
  type LineDraft,
  VAT_STANDARD,
  draftHasWork,
  lineTotals,
  toInvoiceLineInputs,
  updateLineAt,
} from "@/lib/invoice-lines";
import {
  draftErrors,
  errorFieldIdsFor,
  focusFirstInvalidField,
  invoiceInputFromDraft,
  readinessSteps,
} from "./helpers";

/**
 * Every hook, mutation and handler of the new-invoice form, in the order the
 * page has always called them (R126 split). The submit flow is cut at its
 * existing return boundaries into submit → createFromSession →
 * reportCreateFailure; the idempotency key, the X-Idempotency-Key header and
 * the pending-body reuse live in the create mutation and `original.body`,
 * untouched. `errors` is computed every render on purpose (aria-invalid /
 * aria-describedby timing).
 */
export function useInvoiceNewForm() {
  usePageTitle("New invoice");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data: catalogue } = useListErrorCatalogue();
  const drafts = useInvoiceDrafts();
  const { draft, setDraft } = drafts;
  const submission = drafts.state.submission;
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

  const errors = draftErrors(draft);
  const isValid = Object.keys(errors).length === 0;

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft((d) => ({ ...d, lines: updateLineAt(d.lines, i, patch) }));

  // The failed-create toast. Once the command started and the session still
  // holds a submission the outcome is uncertain, and the honest answer is
  // "retry the original", never "try again with a fresh request".
  const reportCreateFailure = (
    e: unknown,
    commandStarted: boolean,
    submittedSession: InvoiceDraftSession,
  ) => {
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
  };

  // The create stage of submit: save (or reuse the pending body), send the
  // idempotent command, close the session and navigate. Every early return
  // sits exactly where the pre-split flow returned; `clientPartyId` is the
  // value submit narrowed, never re-derived from `me` here.
  const createFromSession = async (
    work: SessionWork,
    submittedSession: InvoiceDraftSession,
    original: ReturnType<InvoiceDraftSession["refreshSubmission"]>,
    clientPartyId: string,
  ) => {
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
      commandStarted = true;
      const res = await create.mutateAsync({
        work,
        journalKey: operationKey,
        session: submittedSession,
        data:
          original?.status === "pending"
            ? original.body
            : invoiceInputFromDraft(draft, clientPartyId, lines),
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
      reportCreateFailure(e, commandStarted, submittedSession);
    } finally {
      if (creating.current === work) {
        creating.current = null;
        if (work.current()) setSubmitting(false);
      }
      work.close();
    }
  };

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
      focusFirstInvalidField(errorFieldIdsFor(draft, errors));
      return;
    }
    if (!me?.clientPartyId) return;
    const clientPartyId = me.clientPartyId;
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
    await createFromSession(work, submittedSession, original, clientPartyId);
  };

  const checklist = readinessSteps(draft, selectedBuyer);

  return {
    drafts,
    draft,
    setDraft,
    submission,
    submitting,
    me,
    clerkLit,
    clerkText,
    setClerkText,
    clerkNote,
    clerkDraft,
    draftWithClerk,
    discardDraft,
    showErrors,
    addCustomerOpen,
    setAddCustomerOpen,
    frequentItems,
    addFrequentItem,
    tinGuidance,
    selectedBuyer,
    totals,
    errors,
    isValid,
    setLine,
    checklist,
    submit,
  };
}

export type InvoiceNewFormState = ReturnType<typeof useInvoiceNewForm>;
