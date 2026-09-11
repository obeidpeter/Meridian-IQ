import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCreateInvoice } from "@workspace/api-client-react";
import type { FieldError } from "@workspace/api-client-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Alert } from "react-native";

import { newLine, todayISO } from "@/lib/invoice-create";
import { computeTotals } from "@/lib/invoice-form";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";
import {
  newInvoiceIntent,
  readInvoiceIntent,
  saveInvoiceIntent,
  type InvoiceIntent,
  type InvoiceIntentForm,
  type InvoiceIntentScope,
} from "@/lib/invoice-intent";
import { getAuthGeneration } from "@/lib/query";

/**
 * The create tab's draft in one bag: the form fields and their inline
 * errors, and the persisted invoice INTENT they hydrate from and save to —
 * the idempotency key lives on the intent, so the create mutation that
 * sends it as `X-Idempotency-Key` is owned here too. The setters the two
 * effects call are local, which keeps their dependency arrays exactly
 * [scope, restoreAttempt] and [form, hydrated].
 */
export function useInvoiceDraft({
  scope,
  isCurrent,
  submittingRef,
}: {
  scope: InvoiceIntentScope;
  /** True while the auth generation this form mounted under is still live. */
  isCurrent: () => boolean;
  /** The shell's synchronous submit re-entrancy guard (a reset waits on it). */
  submittingRef: MutableRefObject<boolean>;
}) {
  const [buyerPartyId, setBuyerPartyId] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [lineErrors, setLineErrors] = useState<LineErrors>({});
  const [dateError, setDateError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  // Remembers the draft created on a prior (failed) attempt so a retry resumes
  // at validate→submit instead of creating a DUPLICATE invoice.
  const draftIdRef = useRef<string | null>(null);
  const intentRef = useRef<InvoiceIntent | null>(null);
  const [intent, setIntent] = useState<InvoiceIntent | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const createInvoice = useCreateInvoice({
    request: { headers: { "X-Idempotency-Key": intent?.key ?? "" } },
  });
  const form = useMemo<InvoiceIntentForm>(
    () => ({ buyerPartyId, invoiceNumber, issueDate, notes, lines }),
    [buyerPartyId, invoiceNumber, issueDate, notes, lines],
  );
  const applyForm = (next: InvoiceIntentForm) => {
    setBuyerPartyId(next.buyerPartyId);
    setInvoiceNumber(next.invoiceNumber);
    setIssueDate(next.issueDate);
    setNotes(next.notes);
    setLines(next.lines);
  };
  useEffect(() => {
    let active = true;
    setHydrated(false);
    const current = getAuthGeneration();
    void readInvoiceIntent(AsyncStorage, scope)
      .then((stored) => {
        if (!active || current !== getAuthGeneration()) return;
        const next =
          stored ??
          newInvoiceIntent(scope, {
            buyerPartyId: null,
            invoiceNumber: "",
            issueDate: todayISO(),
            notes: "",
            lines: [newLine()],
          });
        intentRef.current = next;
        draftIdRef.current = next.invoiceId;
        setIntent(next);
        setBuyerPartyId(next.form.buyerPartyId);
        setInvoiceNumber(next.form.invoiceNumber);
        setIssueDate(next.form.issueDate);
        setNotes(next.form.notes);
        setLines(next.form.lines);
        setHydrated(true);
      })
      .catch(() => {
        if (active && current === getAuthGeneration())
          setBanner({
            tone: "error",
            message:
              "Could not load the saved draft. Try loading it again before creating an invoice, or choose to reset the form.",
          });
      });
    return () => {
      active = false;
    };
  }, [scope, restoreAttempt]);

  useEffect(() => {
    if (
      !hydrated ||
      !intentRef.current ||
      intentRef.current.payload ||
      intentRef.current.invoiceId
    )
      return;
    const current = getAuthGeneration();
    const next = { ...intentRef.current, form };
    intentRef.current = next;
    void saveInvoiceIntent(
      AsyncStorage,
      next,
      () => current === getAuthGeneration(),
    ).catch(() => {
      if (current === getAuthGeneration())
        setBanner({
          tone: "error",
          message:
            "The invoice draft could not be saved on this device. Submission will retry storage before contacting the server.",
        });
    });
  }, [form, hydrated]);

  const totals = useMemo(() => computeTotals(lines), [lines]);

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
    // Clear a line's inline error as soon as the user edits it.
    setLineErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const removeLine = (key: string) =>
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.key !== key),
    );

  // The three error resets a submit and a reset share. Never the banner: a
  // successful create sets its banner and then resets the form.
  const clearErrors = () => {
    setFieldErrors([]);
    setLineErrors({});
    setDateError(null);
  };

  const resetForm = async () => {
    const nextForm = {
      buyerPartyId: null,
      invoiceNumber: "",
      issueDate: todayISO(),
      notes: "",
      lines: [newLine()],
    };
    const next = newInvoiceIntent(scope, nextForm);
    try {
      await saveInvoiceIntent(AsyncStorage, next, isCurrent);
    } catch {
      if (isCurrent())
        setBanner({
          tone: "error",
          message:
            "Could not save the new draft. The previous draft and its submission details were kept.",
        });
      return;
    }
    if (!isCurrent()) return;
    intentRef.current = next;
    setIntent(next);
    setHydrated(true);
    setBuyerPartyId(null);
    setInvoiceNumber("");
    setIssueDate(todayISO());
    setNotes("");
    setLines(nextForm.lines);
    clearErrors();
    // A fresh form means a fresh invoice.
    draftIdRef.current = null;
  };

  const requestReset = () => {
    if (submittingRef.current) return;
    if (intentRef.current?.payload || !hydrated) {
      Alert.alert(
        "Start a new invoice?",
        "A previous attempt may already have created an invoice. Check your invoice list before starting a new one.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Start new invoice", onPress: () => void resetForm() },
        ],
      );
    } else void resetForm();
  };

  const errorFor = (field: string): string | undefined =>
    fieldErrors.find((e) => e.field === field || e.field.endsWith(field))
      ?.message;

  const retryRestore = () => setRestoreAttempt((value) => value + 1);

  return {
    buyerPartyId,
    setBuyerPartyId,
    invoiceNumber,
    setInvoiceNumber,
    issueDate,
    setIssueDate,
    notes,
    setNotes,
    lines,
    setLines,
    fieldErrors,
    setFieldErrors,
    lineErrors,
    setLineErrors,
    dateError,
    setDateError,
    banner,
    setBanner,
    draftIdRef,
    intentRef,
    intent,
    setIntent,
    hydrated,
    createInvoice,
    form,
    applyForm,
    totals,
    updateLine,
    addLine,
    removeLine,
    clearErrors,
    resetForm,
    requestReset,
    errorFor,
    retryRestore,
  };
}

export type InvoiceDraftState = ReturnType<typeof useInvoiceDraft>;
