import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getListInvoicesQueryKey,
  useSubmitInvoice,
  useValidateInvoice,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LineItemCard, TotalsCard } from "@/components/invoice-line-editor";
import { BuyerPicker } from "@/components/buyer-picker";
import { FieldErrorList } from "@/components/invoice-create/field-error-list";
import { VoiceDraftCard } from "@/components/invoice-create/voice-draft-card";
import { ScrollHost } from "@/components/KeyboardAwareScrollViewCompat";
import type { Scrollable } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Banner,
  rowBetween,
  screenContent,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useBuyerPicker } from "@/hooks/useBuyerPicker";
import { useInvoiceDraft } from "@/hooks/useInvoiceDraft";
import { useVoiceDraft } from "@/hooks/useVoiceDraft";
import { serverFieldErrors, serverMessage } from "@/lib/api-error";
import { buildInvoicePayload, localInvoiceError } from "@/lib/invoice-create";
import { isValidISODate, normalizeLines } from "@/lib/invoice-form";
import { useSession } from "@/lib/session";
import { getAuthGeneration } from "@/lib/query";
import {
  prepareInvoiceIntent,
  confirmInvoiceIntent,
  saveInvoiceIntent,
  type InvoiceIntent,
} from "@/lib/invoice-intent";

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

  // Synchronous re-entrancy guard: a double-tap in the same frame can fire
  // before React commits the disabled prop, so guard here too.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<Scrollable | null>(null);

  const scrollToTop = () => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  };

  const draft = useInvoiceDraft({ scope, isCurrent, submittingRef });
  const {
    buyerPartyId,
    setBuyerPartyId,
    invoiceNumber,
    setInvoiceNumber,
    issueDate,
    setIssueDate,
    notes,
    setNotes,
    lines,
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
  } = draft;
  const buyerPicker = useBuyerPicker(
    { ...scope, generation: epoch.current },
    buyerPartyId,
    hydrated && verified,
  );
  const voice = useVoiceDraft({ me, buyerPicker, draft, scrollToTop });

  const busy =
    submitting ||
    !hydrated ||
    createInvoice.isPending ||
    validateInvoice.isPending ||
    submitInvoice.isPending;

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
      voice.applying ||
      voice.isPending
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      setBanner(null);
      clearErrors();

      const localError = localInvoiceError({
        clientPartyId,
        buyerPartyId,
        buyerSelected: !!buyerPicker.selected,
        invoiceNumber,
        issueDate,
        lines,
      });
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
        const payload = buildInvoicePayload({
          clientPartyId: clientPartyId!,
          buyerPartyId: buyerPartyId!,
          invoiceNumber,
          issueDate,
          notes,
          payloadLines,
        });
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
        const errs = serverFieldErrors(error);
        if (errs) setFieldErrors(errs);
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
          onPress={retryRestore}
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
        <VoiceDraftCard voice={voice} busy={busy} verified={verified} />

        <BuyerPicker
          picker={buyerPicker}
          selectedId={buyerPartyId}
          onSelect={setBuyerPartyId}
          disabled={busy || voice.busy}
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

        <FieldErrorList errors={fieldErrors} />

        <AppButton
          label={busy ? "Submitting…" : "Create & submit invoice"}
          icon="send"
          onPress={handleSubmit}
          loading={busy}
          disabled={
            busy ||
            !verified ||
            voice.busy ||
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
            voice.busy
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
