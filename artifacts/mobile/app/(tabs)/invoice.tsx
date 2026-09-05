import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getListInvoicesQueryKey,
  InvoiceInputCategory,
  InvoiceInputKind,
  useCreateInvoice,
  useDraftInvoiceWithClerk,
  useSubmitInvoice,
  useValidateInvoice,
} from "@workspace/api-client-react";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import type { FieldError } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LineItemCard, TotalsCard } from "@/components/invoice-line-editor";
import { BuyerPicker } from "@/components/buyer-picker";
import { ScrollHost } from "@/components/KeyboardAwareScrollViewCompat";
import type { Scrollable } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
  Banner,
  Card,
  rowBetween,
  screenContent,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useBuyerPicker } from "@/hooks/useBuyerPicker";
import { hasStatus, serverMessage } from "@/lib/api-error";
import { applyDraftProposal } from "@/lib/draft-voice";
import {
  blankLine,
  computeTotals,
  isValidISODate,
  normalizeLines,
  parseNumeric,
} from "@/lib/invoice-form";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";
import { useSession } from "@/lib/session";
import { getAuthGeneration } from "@/lib/query";
import {
  newInvoiceIntent,
  prepareInvoiceIntent,
  confirmInvoiceIntent,
  readInvoiceIntent,
  saveInvoiceIntent,
  type InvoiceIntent,
  type InvoiceIntentForm,
} from "@/lib/invoice-intent";

let lineCounter = 0;
function newLine(): LineDraft {
  lineCounter += 1;
  return blankLine(`line-${Date.now()}-${lineCounter}`);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Turn a server field path (e.g. "lines.0.unitPrice") into a human label
// (e.g. "Line 1 · Unit price").
const FIELD_LABELS: Record<string, string> = {
  unitPrice: "Unit price",
  quantity: "Quantity",
  vatRate: "VAT rate",
  description: "Description",
  invoiceNumber: "Invoice number",
  issueDate: "Issue date",
  dueDate: "Due date",
  buyerPartyId: "Buyer",
  supplierPartyId: "Supplier",
  notes: "Notes",
};
function humanizeKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  return (
    FIELD_LABELS[last] ??
    last.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
  );
}
function humanizeFieldPath(path: string): string {
  const lineMatch = path.match(/^lines\.(\d+)\.(.+)$/);
  if (lineMatch) {
    return `Line ${Number(lineMatch[1]) + 1} · ${humanizeKey(lineMatch[2])}`;
  }
  return humanizeKey(path);
}

export default function InvoiceScreen() {
  const { me, clientPartyId } = useSession();
  return (
    <InvoiceForm
      key={JSON.stringify([
        me?.userId,
        me?.firmId,
        clientPartyId,
        getAuthGeneration(),
      ])}
    />
  );
}

function InvoiceForm() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { clientPartyId, me, verified } = useSession();
  const scope = useMemo(
    () => ({
      userId: me?.userId ?? "",
      firmId: me?.firmId ?? null,
      clientPartyId: clientPartyId ?? "",
    }),
    [me?.userId, me?.firmId, clientPartyId],
  );
  const epoch = useRef(getAuthGeneration());
  const isCurrent = () => epoch.current === getAuthGeneration();

  const validateInvoice = useValidateInvoice();
  const submitInvoice = useSubmitInvoice();
  const voiceDraft = useDraftInvoiceWithClerk();

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
  const buyerPicker = useBuyerPicker(
    { ...scope, generation: epoch.current },
    buyerPartyId,
    hydrated && verified,
  );
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
              "The saved invoice draft could not be loaded. Retry before creating an invoice, or explicitly reset the form.",
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
  // Synchronous re-entrancy guard: a double-tap in the same frame can fire
  // before React commits the disabled prop, so guard here too.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<Scrollable | null>(null);

  const scrollToTop = () => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  };

  // "Speak it" (idea #7): record a short voice note, let the server
  // transcribe it and propose a draft, then prefill THIS form — the user
  // reviews and saves through the ordinary create path; nothing exists until
  // they do. Gated on the same capability as every Clerk capture surface.
  const canSpeak = !!me?.capabilities?.includes("clerk.capture");
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [voiceApplying, setVoiceApplying] = useState(false);
  // Synchronous re-entrancy guard, same hazard submittingRef covers below: a
  // double-tap can fire before React commits the disabled prop, and two
  // stop-and-draft runs would mean two paid transcriptions.
  const voiceBusyRef = useRef(false);

  const startRecording = async () => {
    if (voiceBusyRef.current) return;
    voiceBusyRef.current = true;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setBanner({
          tone: "error",
          message: "Microphone access is needed to speak an invoice.",
        });
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      recorder.record();
      setRecording(true);
    } catch {
      // Recording never started: put the audio session back and say so —
      // a swallowed rejection here would strand the device in record mode.
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setBanner({
        tone: "error",
        message: "Recording couldn't start — try again.",
      });
    } finally {
      voiceBusyRef.current = false;
    }
  };

  const stopAndDraft = async () => {
    if (voiceBusyRef.current || voiceDraft.isPending || voiceApplying) return;
    voiceBusyRef.current = true;
    let audioBase64: string;
    try {
      setRecording(false);
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        setBanner({
          tone: "error",
          message: "Nothing was recorded — try again.",
        });
        return;
      }
      audioBase64 = await new File(uri).base64();
    } catch {
      setBanner({
        tone: "error",
        message: "The voice note couldn't be read — try recording again.",
      });
      return;
    } finally {
      // Whatever happened above, never leave the device audio session in
      // recording mode.
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      voiceBusyRef.current = false;
    }
    if (!buyerPicker.isCurrent()) return;
    voiceDraft.mutate(
      { data: { audioBase64 } },
      {
        onSuccess: async (res) => {
          if (!buyerPicker.isCurrent()) return;
          setVoiceApplying(true);
          try {
            const authorizedIds: string[] = [];
            const suggestedId = res.buyerSuggestions[0]?.partyId;
            if (suggestedId) {
              try {
                const buyer = await buyerPicker.resolveBuyer(suggestedId);
                authorizedIds.push(buyer.id);
              } catch {
                // A suggestion is not authorization, including one outside
                // the current search page. Never fall back to cached IDs.
              }
            }
            if (!buyerPicker.isCurrent()) return;
            lineCounter += 1;
            const applied = applyDraftProposal(
              res,
              authorizedIds,
              `voice-${lineCounter}-`,
            );
            if (applied.invoiceNumber) setInvoiceNumber(applied.invoiceNumber);
            if (applied.issueDate) setIssueDate(applied.issueDate);
            if (applied.buyerPartyId) setBuyerPartyId(applied.buyerPartyId);
            if (applied.lines) setLines(applied.lines);
            const heard = res.transcript ? `Heard: “${res.transcript}”. ` : "";
            setBanner({
              tone: "success",
              message:
                !applied.buyerPartyId && (suggestedId || applied.buyerNameRead)
                  ? `${heard}The suggested buyer could not be verified. Choose an available buyer, then check every field before saving.`
                  : `${heard}Check every field before saving.`,
            });
            scrollToTop();
          } finally {
            setVoiceApplying(false);
          }
        },
        onError: (e) => {
          if (!buyerPicker.isCurrent()) return;
          setBanner({
            tone: "error",
            message: hasStatus(e, 503)
              ? "Clerk is switched off right now — fill the form manually."
              : hasStatus(e, 429)
                ? "Your firm's monthly Clerk allowance is used up."
                : (serverMessage(e) ??
                  "Clerk couldn't draft from that voice note. Try again, or type the details."),
          });
          scrollToTop();
        },
      },
    );
  };

  const totals = useMemo(() => computeTotals(lines), [lines]);

  const busy =
    submitting ||
    !hydrated ||
    createInvoice.isPending ||
    validateInvoice.isPending ||
    submitInvoice.isPending;

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
            "The new invoice draft could not be saved. The previous intent has been retained.",
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
    setFieldErrors([]);
    setLineErrors({});
    setDateError(null);
    // A fresh form means a fresh invoice.
    draftIdRef.current = null;
  };

  const requestReset = () => {
    if (submittingRef.current) return;
    if (intentRef.current?.payload || !hydrated) {
      Alert.alert(
        "Start a new invoice?",
        "A previous attempt may already have created an invoice. Check your invoices before starting a separate intent.",
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

  const validateLocal = (): string | null => {
    if (!clientPartyId) return "No client selected.";
    if (!buyerPartyId) return "Choose a buyer for this invoice.";
    if (!buyerPicker.selected)
      return "Verify the selected buyer or choose an available buyer.";
    if (!invoiceNumber.trim()) return "Enter an invoice number.";
    if (!issueDate.trim()) return "Enter an issue date.";
    const hasValidLine = lines.some((l) => {
      const price = parseNumeric(l.unitPrice);
      return l.description.trim() !== "" && price !== null && price > 0;
    });
    if (!hasValidLine)
      return "Add at least one line item with a description and price.";
    return null;
  };

  const invalidateInvoiceQueries = async () => {
    await Promise.all([
      clientPartyId
        ? queryClient.invalidateQueries({
            queryKey: getGetDashboardSummaryQueryKey({ clientPartyId }),
          })
        : Promise.resolve(),
      // A submitted invoice becomes an outstanding receivable, so the home
      // card's aging buckets shift too.
      clientPartyId
        ? queryClient.invalidateQueries({
            queryKey: getGetReceivablesSummaryQueryKey({ clientPartyId }),
          })
        : Promise.resolve(),
      // Prefix key matches every invoice-list query regardless of status filter.
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() }),
    ]);
  };

  const handleSubmit = async () => {
    // Synchronous re-entrancy guard (see submittingRef above).
    if (
      submittingRef.current ||
      !hydrated ||
      !verified ||
      !isCurrent() ||
      voiceApplying ||
      voiceDraft.isPending
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      setBanner(null);
      setFieldErrors([]);
      setLineErrors({});
      setDateError(null);

      const localError = validateLocal();
      if (localError) {
        setBanner({ tone: "error", message: localError });
        scrollToTop();
        return;
      }

      // Inline numeric + date validation before any network call.
      const { payloadLines, lineErrs } = normalizeLines(lines);
      let hasFieldError = false;
      if (Object.keys(lineErrs).length > 0) {
        setLineErrors(lineErrs);
        hasFieldError = true;
      }
      if (!isValidISODate(issueDate.trim())) {
        setDateError("Enter the issue date as YYYY-MM-DD.");
        hasFieldError = true;
      }
      if (hasFieldError) {
        setBanner({
          tone: "error",
          message: "Fix the highlighted fields before submitting.",
        });
        scrollToTop();
        return;
      }

      try {
        const payload = {
          supplierPartyId: clientPartyId!,
          buyerPartyId: buyerPartyId!,
          invoiceNumber: invoiceNumber.trim(),
          issueDate: issueDate.trim(),
          kind: InvoiceInputKind.invoice,
          category: InvoiceInputCategory.b2b,
          notes: notes.trim() || undefined,
          lines: payloadLines,
        };
        const current = intentRef.current;
        if (!current) throw new Error("Invoice intent is not ready.");
        let prepared: InvoiceIntent;
        try {
          prepared = prepareInvoiceIntent(current, form, payload);
        } catch (error) {
          setBanner({
            tone: "error",
            message:
              error instanceof Error
                ? error.message
                : "Restore the original draft before retrying.",
          });
          scrollToTop();
          return;
        }
        // Persist both key and exact command before the first network attempt.
        intentRef.current = prepared;
        setIntent(prepared);
        await saveInvoiceIntent(AsyncStorage, prepared, isCurrent);
        if (!isCurrent()) return;
        // Resume an existing draft if we created one on a prior attempt;
        // otherwise create it now. This is what keeps a retry idempotent.
        let invoiceId = current.invoiceId ?? draftIdRef.current;
        let invoiceNumberForMessage = invoiceNumber.trim();
        if (!invoiceId) {
          const created = await createInvoice.mutateAsync({
            data: payload,
          });
          invoiceId = created.invoice.id;
          invoiceNumberForMessage = created.invoice.invoiceNumber;
          draftIdRef.current = invoiceId;
          const createdIntent = confirmInvoiceIntent(prepared, invoiceId);
          intentRef.current = createdIntent;
          setIntent(createdIntent);
          await saveInvoiceIntent(AsyncStorage, createdIntent, isCurrent);
        }
        if (!isCurrent()) return;

        const validation = await validateInvoice.mutateAsync({ id: invoiceId });
        if (!validation.ok) {
          setFieldErrors(validation.errors);
          setBanner({
            tone: "error",
            message:
              "This invoice needs changes before it can be submitted. Review the flagged fields.",
          });
          scrollToTop();
          // A draft now exists server-side even though we couldn't submit it.
          await invalidateInvoiceQueries();
          return;
        }

        await submitInvoice.mutateAsync({ id: invoiceId });

        await invalidateInvoiceQueries();
        setBanner({
          tone: "success",
          message: `Invoice ${invoiceNumberForMessage} submitted for fiscalisation.`,
        });
        // Only now is the draft fully consumed — safe to forget it.
        await resetForm();
      } catch (error) {
        if (!isCurrent()) return;
        const data =
          error && typeof error === "object"
            ? (error as { data?: unknown }).data
            : null;
        if (data && typeof data === "object") {
          const errs = (data as { errors?: unknown }).errors;
          if (Array.isArray(errs)) setFieldErrors(errs as FieldError[]);
        }
        // Unlike the detail/fix screens, this banner only ever surfaces a
        // server-sent `message` — anything else (an `{ error }` payload, a
        // transport failure) keeps the friendly fallback.
        const message =
          serverMessage(error) ??
          "We couldn't submit this invoice. Please try again.";
        setBanner({ tone: "error", message });
        scrollToTop();
        // If a draft was created before the failure, keep its id (so the next
        // tap resumes rather than duplicates) and refresh the lists.
        if (draftIdRef.current) await invalidateInvoiceQueries();
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <ScrollHost
      ref={scrollRef}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        screenContent,
        { paddingBottom: insets.bottom + 120 },
      ]}
      bottomOffset={20}
    >
      {banner ? (
        <View style={{ marginBottom: 16 }}>
          <Banner tone={banner.tone} message={banner.message} />
        </View>
      ) : null}
      {!hydrated && (
        <AppButton
          label="Retry loading draft"
          icon="refresh-cw"
          variant="ghost"
          onPress={() => setRestoreAttempt((value) => value + 1)}
        />
      )}
      {intent?.payload && (
        <AppButton
          label="Restore original draft"
          icon="rotate-ccw"
          variant="ghost"
          disabled={busy}
          onPress={() => applyForm(intentRef.current!.form)}
        />
      )}
      {intent?.invoiceId && (
        <AppButton
          label="Review saved invoice"
          icon="edit"
          variant="ghost"
          disabled={busy}
          onPress={() =>
            router.push({
              pathname: "/invoices/edit/[id]",
              params: { id: intent.invoiceId! },
            })
          }
        />
      )}

      <View style={{ gap: 16 }}>
        {canSpeak ? (
          <Card style={{ gap: 8 }}>
            <View style={rowBetween}>
              <AppText variant="label">Speak it</AppText>
              {recording ? <Badge label="Recording…" tone="warning" /> : null}
            </View>
            <AppText variant="caption" color={colors.mutedForeground}>
              Say the invoice — buyer, amount, what it&apos;s for — and Clerk
              prefills this form. Nothing is saved until you submit.
            </AppText>
            <AppButton
              label={
                voiceDraft.isPending || voiceApplying
                  ? "Drafting…"
                  : recording
                    ? "Stop & draft"
                    : "Record a voice note"
              }
              variant="ghost"
              icon={recording ? "square" : "mic"}
              onPress={recording ? stopAndDraft : startRecording}
              loading={voiceDraft.isPending || voiceApplying}
              disabled={
                voiceDraft.isPending || voiceApplying || busy || !verified
              }
            />
          </Card>
        ) : null}

        <BuyerPicker
          picker={buyerPicker}
          selectedId={buyerPartyId}
          onSelect={setBuyerPartyId}
          disabled={busy || voiceDraft.isPending || voiceApplying}
          error={errorFor("buyerPartyId")}
        />

        <TextField
          label="Invoice number"
          value={invoiceNumber}
          onChangeText={setInvoiceNumber}
          placeholder="INV-0001"
          autoCapitalize="characters"
          error={errorFor("invoiceNumber")}
        />
        <TextField
          label="Issue date"
          value={issueDate}
          onChangeText={(t) => {
            setIssueDate(t);
            if (dateError) setDateError(null);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          error={dateError ?? errorFor("issueDate")}
        />

        <View style={{ gap: 12 }}>
          <View style={rowBetween}>
            <AppText variant="heading">Line items</AppText>
            <Pressable onPress={addLine} style={styles.addBtn}>
              <Feather name="plus" size={16} color={colors.primary} />
              <AppText variant="label" color={colors.primary}>
                Add
              </AppText>
            </Pressable>
          </View>

          {lines.map((line, index) => (
            <LineItemCard
              key={line.key}
              line={line}
              index={index}
              canRemove={lines.length > 1}
              errors={lineErrors[line.key]}
              onChange={(patch) => updateLine(line.key, patch)}
              onRemove={() => removeLine(line.key)}
            />
          ))}
        </View>

        <TextField
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Payment terms, reference…"
          multiline
          style={{ height: 80, paddingTop: 12, textAlignVertical: "top" }}
        />

        <TotalsCard totals={totals} />

        {fieldErrors.length > 0 ? (
          <View style={{ gap: 4 }}>
            {fieldErrors.map((e, i) => (
              <View
                key={`${e.field}-${i}`}
                style={{ flexDirection: "row", gap: 6 }}
              >
                <Badge label={humanizeFieldPath(e.field)} tone="critical" />
                <AppText
                  variant="caption"
                  color={colors.destructiveText}
                  style={{ flex: 1 }}
                >
                  {e.message}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}

        <AppButton
          label={busy ? "Submitting…" : "Create & submit invoice"}
          icon="send"
          onPress={handleSubmit}
          loading={busy}
          disabled={
            busy ||
            !verified ||
            voiceDraft.isPending ||
            voiceApplying ||
            (!!buyerPartyId && !buyerPicker.selected)
          }
        />
        <AppButton
          label="Reset form"
          variant="ghost"
          icon="rotate-ccw"
          onPress={requestReset}
          disabled={
            createInvoice.isPending ||
            validateInvoice.isPending ||
            submitInvoice.isPending ||
            voiceDraft.isPending ||
            voiceApplying
          }
        />
      </View>
    </ScrollHost>
  );
}

const styles = StyleSheet.create({
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
});
