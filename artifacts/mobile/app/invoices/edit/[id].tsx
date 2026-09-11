import {
  getGetDashboardSummaryQueryKey,
  getGetInvoiceQueryKey,
  getGetPartyQueryKey,
  getListInvoicesQueryKey,
  useGetInvoice,
  useUpdateInvoice,
  useUpdateParty,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConflictCard } from "@/components/fix-invoice/conflict-card";
import { InvoiceFieldsCard } from "@/components/fix-invoice/invoice-fields-card";
import { LineItemsSection } from "@/components/fix-invoice/line-items-section";
import { PartySection } from "@/components/fix-invoice/party-section";
import { RailFocusCard } from "@/components/fix-invoice/rail-focus-card";
import { TotalsCard } from "@/components/invoice-line-editor";
import { ScrollHost } from "@/components/KeyboardAwareScrollViewCompat";
import type { Scrollable } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Banner,
  Card,
  CardSkeleton,
  ErrorState,
  screenContent,
  stackHeaderOptions,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useFixInvoiceFields } from "@/hooks/useFixInvoiceFields";
import { useFixInvoiceParties } from "@/hooks/useFixInvoiceParties";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { apiErrorMessage, errorStatus } from "@/lib/api-error";
import {
  checkFixForm,
  focusAreasFor,
  invoicePatchFor,
  partyPatch,
} from "@/lib/fix-invoice";
import { useSession } from "@/lib/session";

export default function FixInvoiceScreen() {
  const { id: rawId, code: rawCode } = useLocalSearchParams<{
    id: string;
    code?: string;
  }>();
  const id = typeof rawId === "string" ? rawId : "";
  const errorCode = typeof rawCode === "string" ? rawCode : "";
  const focus = focusAreasFor(errorCode);

  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { me } = useSession();

  const detailQuery = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id) },
  });
  const invoice = detailQuery.data?.invoice;

  const fields = useFixInvoiceFields(detailQuery.data);
  const {
    invoiceNumber,
    issueDate,
    dueDate,
    notes,
    lines,
    linesDirty,
    setLinesDirty,
    prefilled,
    setPrefilled,
    expectedRevision,
    setExpectedRevision,
    lineErrors,
    setLineErrors,
    setIssueDateError,
    setDueDateError,
    editable,
    fieldsDirty,
    totals,
    updateLine,
    addLine,
    removeLine,
  } = fields;
  const {
    supplierId,
    buyerId,
    supplierQuery,
    buyerQuery,
    supplierDraft,
    setSupplierDraft,
    buyerDraft,
    setBuyerDraft,
    supplierLocked,
    supplierLoadFailed,
    buyerLocked,
    buyerLoadFailed,
    partyDirty,
  } = useFixInvoiceParties({ invoice, me });

  const updateInvoice = useUpdateInvoice();
  const updateParty = useUpdateParty();

  const [banner, setBanner] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const saveInFlight = useRef(false);

  const scrollRef = useRef<Scrollable | null>(null);
  const scrollToTop = () => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  };

  const saving = updateInvoice.isPending || updateParty.isPending;

  // Dirty check: any typed change to the invoice fields, the lines, or an
  // editable party draft. Gates the unsaved-changes guard.
  const isDirty = prefilled && (fieldsDirty || linesDirty || partyDirty);
  const { allowLeaveRef, confirmLeave } = useUnsavedChangesGuard(isDirty);

  const handleSave = async () => {
    if (
      !invoice ||
      expectedRevision === null ||
      saving ||
      conflict ||
      saveInFlight.current
    )
      return;
    setBanner(null);
    const check = checkFixForm({
      invoiceNumber,
      issueDate,
      dueDate,
      lines,
      linesDirty,
    });
    setIssueDateError(check.issueDateError);
    setDueDateError(check.dueDateError);
    setLineErrors(check.lineErrors);
    if (!check.ok) {
      setBanner(check.banner);
      scrollToTop();
      return;
    }

    saveInFlight.current = true;
    let partySaved = false;
    try {
      // Party fixes first (a corrected TIN must be in place before any
      // re-validation/retry re-reads the parties). Requests are serialized —
      // the API applies audit + validation per call.
      if (!supplierLocked && supplierDraft && supplierQuery.data) {
        const patch = partyPatch(supplierDraft, supplierQuery.data);
        if (Object.keys(patch).length > 0) {
          await updateParty.mutateAsync({ id: supplierId, data: patch });
          partySaved = true;
          await queryClient.invalidateQueries({
            queryKey: getGetPartyQueryKey(supplierId),
          });
        }
      }
      if (!buyerLocked && buyerDraft && buyerQuery.data) {
        const patch = partyPatch(buyerDraft, buyerQuery.data);
        if (Object.keys(patch).length > 0) {
          await updateParty.mutateAsync({ id: buyerId, data: patch });
          partySaved = true;
          await queryClient.invalidateQueries({
            queryKey: getGetPartyQueryKey(buyerId),
          });
        }
      }

      const invPatch = invoicePatchFor(
        invoice,
        { invoiceNumber, issueDate, dueDate, notes },
        linesDirty,
        check.payloadLines,
      );
      if (Object.keys(invPatch).length > 0) {
        const saved = await updateInvoice.mutateAsync({
          id,
          data: { ...invPatch, expectedRevision },
        });
        setExpectedRevision(saved.invoice.contentRevision);
      }

      await queryClient.invalidateQueries({
        queryKey: getGetInvoiceQueryKey(id),
      });
      // Refresh the dashboard summary and invoice lists so the fixed invoice is
      // reflected across the app. The invoice's supplier is the client party the
      // dashboard is keyed by.
      await Promise.all([
        invoice.supplierPartyId
          ? queryClient.invalidateQueries({
              queryKey: getGetDashboardSummaryQueryKey({
                clientPartyId: invoice.supplierPartyId,
              }),
            })
          : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() }),
      ]);
      // A successful save is clean — let the back navigation through the guard.
      allowLeaveRef.current = true;
      router.back();
    } catch (e) {
      if (errorStatus(e) === 409) {
        setConflict(true);
        await detailQuery.refetch();
      }
      setBanner(
        (partySaved
          ? "Business details were saved. Invoice changes are incomplete. "
          : "") +
          apiErrorMessage(
            e,
            "We couldn't save these changes. Please try again.",
          ),
      );
      scrollToTop();
    } finally {
      saveInFlight.current = false;
    }
  };

  return (
    <>
      <Stack.Screen
        options={stackHeaderOptions(colors, "Fix invoice details")}
      />
      <ScrollHost
        ref={scrollRef}
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          screenContent,
          { paddingBottom: insets.bottom + 120 },
        ]}
        bottomOffset={20}
      >
        {detailQuery.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={3} />
            <CardSkeleton lines={3} />
          </View>
        ) : detailQuery.isError ? (
          <ErrorState
            message="We couldn't load this invoice."
            onRetry={() => void detailQuery.refetch()}
          />
        ) : !editable ? (
          <Card>
            <AppText variant="body" color={colors.mutedForeground}>
              This invoice has already been transmitted and can no longer be
              edited. To correct it, issue a credit note from the Valo web
              console.
            </AppText>
          </Card>
        ) : (
          <View style={{ gap: 20 }}>
            {banner ? <Banner tone="error" message={banner} /> : null}
            <ConflictCard
              conflict={conflict}
              invoice={invoice}
              detail={detailQuery.data}
              invoiceNumber={invoiceNumber}
              issueDate={issueDate}
              dueDate={dueDate}
              lineCount={lines.length}
              onReload={() => {
                setPrefilled(false);
                setLinesDirty(false);
                setConflict(false);
                setBanner(null);
              }}
              onKeep={(saved) => {
                setExpectedRevision(saved.contentRevision);
                setConflict(false);
                setBanner(null);
              }}
            />

            <RailFocusCard focus={focus} />

            <PartySection
              title="Your business"
              subtitle="Supplier shown on the invoice"
              draft={supplierDraft}
              onChange={(p) =>
                setSupplierDraft((prev) => (prev ? { ...prev, ...p } : prev))
              }
              highlighted={focus.includes("parties")}
              locked={supplierLocked}
              loadFailed={supplierLoadFailed}
              loadFailedMessage="We couldn't load your business details. Check your connection and try again."
              onRetry={() => void supplierQuery.refetch()}
            />

            <PartySection
              title="Customer"
              subtitle="Who the invoice is billed to"
              draft={buyerDraft}
              onChange={(p) =>
                setBuyerDraft((prev) => (prev ? { ...prev, ...p } : prev))
              }
              highlighted={focus.includes("parties")}
              locked={buyerLocked}
              lockedMessage="Your accounting firm manages this customer's registration details. Ask the firm to correct an incorrect TIN, then submit the invoice again."
              loadFailed={buyerLoadFailed}
              loadFailedMessage="Could not load the customer's details. Check your connection and try again."
              onRetry={() => void buyerQuery.refetch()}
            />

            <InvoiceFieldsCard focus={focus} fields={fields} />

            <LineItemsSection
              highlighted={focus.includes("lines")}
              lines={lines}
              lineErrors={lineErrors}
              onAdd={addLine}
              onUpdate={updateLine}
              onRemove={removeLine}
            />

            <TotalsCard totals={totals} />

            <AppButton
              label={saving ? "Saving…" : "Save changes"}
              icon="check"
              onPress={() => void handleSave()}
              loading={saving}
              disabled={saving || conflict}
              testID="button-save-fixes"
            />
            <AppButton
              label="Cancel"
              variant="ghost"
              onPress={confirmLeave}
              disabled={saving}
            />
          </View>
        )}
      </ScrollHost>
    </>
  );
}
