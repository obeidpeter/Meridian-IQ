import { Feather } from "@expo/vector-icons";
import {
  getGetDashboardSummaryQueryKey,
  getGetInvoiceQueryKey,
  getGetPartyQueryKey,
  getListInvoicesQueryKey,
  useGetInvoice,
  useGetParty,
  useUpdateInvoice,
  useUpdateParty,
} from "@workspace/api-client-react";
import type {
  InvoiceLineInput,
  Party,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LineItemCard, TotalsCard } from "@/components/invoice-line-editor";
import { ScrollHost } from "@/components/KeyboardAwareScrollViewCompat";
import type { Scrollable } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Banner,
  Card,
  CardSkeleton,
  ErrorState,
  rowBetween,
  stackHeaderOptions,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage, errorStatus } from "@/lib/api-error";
import {
  blankLine,
  computeTotals,
  isValidISODate,
  normalizeLines,
} from "@/lib/invoice-form";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";

// Which sections a rail error implicates, so the fix flow can point the user
// at the right fields instead of leaving them to guess.
type FocusArea = "parties" | "invoice" | "lines" | "invoiceNumber";
const ERROR_FOCUS: Record<string, FocusArea[]> = {
  MBS_INVALID_TIN: ["parties"],
  MBS_SCHEMA_INVALID: ["invoice", "lines"],
  MBS_DUPLICATE: ["invoiceNumber"],
};

interface PartyDraft {
  legalName: string;
  tin: string;
  cacNumber: string;
  street: string;
  city: string;
}

function partyToDraft(p: Party): PartyDraft {
  return {
    legalName: p.legalName ?? "",
    tin: p.tin ?? "",
    cacNumber: p.cacNumber ?? "",
    street: p.street ?? "",
    city: p.city ?? "",
  };
}

function partyPatch(draft: PartyDraft, original: Party) {
  const patch: Record<string, string | null> = {};
  if (draft.legalName.trim() && draft.legalName.trim() !== original.legalName) {
    patch.legalName = draft.legalName.trim();
  }
  const tin = draft.tin.trim();
  if (tin !== (original.tin ?? "")) patch.tin = tin === "" ? null : tin;
  const cac = draft.cacNumber.trim();
  if (cac !== (original.cacNumber ?? "")) {
    patch.cacNumber = cac === "" ? null : cac;
  }
  const street = draft.street.trim();
  if (street !== (original.street ?? "")) {
    patch.street = street === "" ? null : street;
  }
  const city = draft.city.trim();
  if (city !== (original.city ?? "")) patch.city = city === "" ? null : city;
  return patch;
}

function PartySection({
  title,
  subtitle,
  draft,
  onChange,
  highlighted,
  locked,
  lockedMessage,
  loadFailed = false,
  loadFailedMessage,
  onRetry,
}: {
  title: string;
  subtitle?: string;
  draft: PartyDraft | null;
  onChange: (patch: Partial<PartyDraft>) => void;
  highlighted: boolean;
  locked: boolean;
  lockedMessage?: string;
  loadFailed?: boolean;
  loadFailedMessage?: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppText variant="heading">{title}</AppText>
        {highlighted ? (
          <Feather name="alert-circle" size={16} color={colors.destructive} />
        ) : null}
      </View>
      {subtitle ? (
        <AppText variant="caption" color={colors.mutedForeground}>
          {subtitle}
        </AppText>
      ) : null}
      {loadFailed ? (
        // A transient load failure — surface a retryable message instead of an
        // eternal skeleton.
        <Card style={{ gap: 12 }}>
          <Banner
            tone="error"
            message={
              loadFailedMessage ??
              "We couldn't load these details. Check your connection and try again."
            }
          />
          {onRetry ? (
            <AppButton
              label="Try again"
              icon="refresh-cw"
              variant="secondary"
              fullWidth={false}
              onPress={onRetry}
            />
          ) : null}
        </Card>
      ) : locked ? (
        <Card>
          <AppText variant="body" color={colors.mutedForeground}>
            {lockedMessage ??
              "These details are managed by your accounting firm. Ask them to correct this record."}
          </AppText>
        </Card>
      ) : draft ? (
        <Card
          style={{
            gap: 12,
            borderColor: highlighted ? colors.destructive : colors.border,
            borderWidth: highlighted ? 1 : StyleSheet.hairlineWidth,
          }}
        >
          <TextField
            label="Legal name"
            value={draft.legalName}
            onChangeText={(t) => onChange({ legalName: t })}
            placeholder="Registered business name"
          />
          <TextField
            label="TIN"
            value={draft.tin}
            onChangeText={(t) => onChange({ tin: t })}
            placeholder="12345678-0001"
            autoCapitalize="characters"
            hint={
              highlighted
                ? "The rail rejected a TIN on this invoice — double-check this number."
                : undefined
            }
          />
          <TextField
            label="CAC number (optional)"
            value={draft.cacNumber}
            onChangeText={(t) => onChange({ cacNumber: t })}
            placeholder="RC123456"
            autoCapitalize="characters"
          />
          <TextField
            label="Street"
            value={draft.street}
            onChangeText={(t) => onChange({ street: t })}
            placeholder="Street address"
          />
          <TextField
            label="City"
            value={draft.city}
            onChangeText={(t) => onChange({ city: t })}
            placeholder="City"
          />
        </Card>
      ) : (
        <CardSkeleton lines={3} />
      )}
    </View>
  );
}

export default function FixInvoiceScreen() {
  const { id: rawId, code: rawCode } = useLocalSearchParams<{
    id: string;
    code?: string;
  }>();
  const id = typeof rawId === "string" ? rawId : "";
  const errorCode = typeof rawCode === "string" ? rawCode : "";
  const focus = ERROR_FOCUS[errorCode] ?? [];

  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const detailQuery = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id) },
  });
  const invoice = detailQuery.data?.invoice;

  const supplierId = invoice?.supplierPartyId ?? "";
  const buyerId = invoice?.buyerPartyId ?? "";
  const supplierQuery = useGetParty(supplierId, {
    query: { enabled: !!supplierId, queryKey: getGetPartyQueryKey(supplierId) },
  });
  const buyerQuery = useGetParty(buyerId, {
    query: {
      enabled: !!buyerId,
      queryKey: getGetPartyQueryKey(buyerId),
      retry: false,
    },
  });

  const updateInvoice = useUpdateInvoice();
  const updateParty = useUpdateParty();

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [supplierDraft, setSupplierDraft] = useState<PartyDraft | null>(null);
  const [buyerDraft, setBuyerDraft] = useState<PartyDraft | null>(null);
  const [linesDirty, setLinesDirty] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (prefilled || !detailQuery.data) return;
    const inv = detailQuery.data.invoice;
    setInvoiceNumber(inv.invoiceNumber);
    setIssueDate(inv.issueDate);
    setDueDate(inv.dueDate ?? "");
    setNotes(inv.notes ?? "");
    setLines(
      detailQuery.data.lines.map((l) => ({
        key: l.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        // API stores VAT as a fraction (0.075); the form edits a percent.
        vatRate: String(Number(l.vatRate) * 100),
      })),
    );
    setPrefilled(true);
  }, [detailQuery.data, prefilled]);

  useEffect(() => {
    if (supplierQuery.data && !supplierDraft) {
      setSupplierDraft(partyToDraft(supplierQuery.data));
    }
  }, [supplierQuery.data, supplierDraft]);
  useEffect(() => {
    if (buyerQuery.data && !buyerDraft) {
      setBuyerDraft(partyToDraft(buyerQuery.data));
    }
  }, [buyerQuery.data, buyerDraft]);

  // The server is the authority on editability: submitted/stamped/terminal
  // invoices are content-frozen (the PATCH would 409). Mirror that here so the
  // user is told up-front instead of hitting a dead end on save.
  const editable =
    !invoice ||
    invoice.status === "draft" ||
    invoice.status === "validated" ||
    invoice.status === "failed";

  // The server is also the authority on WHO may edit the buyer: client_users
  // are confined to their own party (403 on the buyer fetch), while firm staff
  // can load and fix buyers on the firm's invoices. Only an explicit 403 means
  // "managed by your firm" — any other load failure is transient, so show a
  // retryable error instead of the misleading lock message.
  const buyerErrorStatus = buyerQuery.isError
    ? errorStatus(buyerQuery.error)
    : undefined;
  const buyerLocked = buyerErrorStatus === 403;
  const buyerLoadFailed = buyerQuery.isError && !buyerLocked;

  // The supplier is the user's own party, so a 403 would still mean "managed by
  // your firm"; any other error is transient. Either way, don't leave the
  // supplier section stuck on an eternal skeleton — surface it.
  const supplierErrorStatus = supplierQuery.isError
    ? errorStatus(supplierQuery.error)
    : undefined;
  const supplierLocked = supplierErrorStatus === 403;
  const supplierLoadFailed = supplierQuery.isError && !supplierLocked;

  const [lineErrors, setLineErrors] = useState<LineErrors>({});
  const [issueDateError, setIssueDateError] = useState<string | null>(null);
  const [dueDateError, setDueDateError] = useState<string | null>(null);

  const scrollRef = useRef<Scrollable | null>(null);
  const scrollToTop = () => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  };

  const totals = useMemo(() => computeTotals(lines), [lines]);

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLinesDirty(true);
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
    setLineErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  const addLine = () => {
    setLinesDirty(true);
    setLines((prev) => [
      ...prev,
      blankLine(`new-${Date.now()}-${prev.length}`),
    ]);
  };
  const removeLine = (key: string) => {
    setLinesDirty(true);
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.key !== key),
    );
  };

  const saving = updateInvoice.isPending || updateParty.isPending;

  // Dirty check: any typed change to the invoice fields, the lines, or an
  // editable party draft. Gates the unsaved-changes guard below.
  const supplierPatchDirty =
    !supplierLocked &&
    !!supplierDraft &&
    !!supplierQuery.data &&
    Object.keys(partyPatch(supplierDraft, supplierQuery.data)).length > 0;
  const buyerPatchDirty =
    !buyerLocked &&
    !!buyerDraft &&
    !!buyerQuery.data &&
    Object.keys(partyPatch(buyerDraft, buyerQuery.data)).length > 0;
  const fieldsDirty =
    !!invoice &&
    (invoiceNumber.trim() !== invoice.invoiceNumber ||
      issueDate.trim() !== invoice.issueDate ||
      dueDate.trim() !== (invoice.dueDate ?? "") ||
      notes.trim() !== (invoice.notes ?? ""));
  const isDirty =
    prefilled &&
    (fieldsDirty || linesDirty || supplierPatchDirty || buyerPatchDirty);

  // Unsaved-changes guard. This is a pushed Stack screen, so a header-back or an
  // iOS swipe-back would otherwise silently discard typed fixes. expo-router
  // doesn't re-export usePreventRemove, so we hook the underlying `beforeRemove`
  // navigation event it's built on. `allowLeaveRef` lets a confirmed discard or
  // a successful save proceed without re-prompting.
  const navigation = useNavigation();
  const allowLeaveRef = useRef(false);

  // The shared "Discard changes?" confirm for both leave paths (header/gesture
  // back and the Cancel button). Confirming clears the guard so the discard
  // navigation isn't re-prompted.
  const confirmDiscard = (onDiscard: () => void) => {
    Alert.alert(
      "Discard changes?",
      "You have unsaved fixes on this invoice. If you leave now, they'll be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            allowLeaveRef.current = true;
            onDiscard();
          },
        },
      ],
    );
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || !isDirty) return;
      e.preventDefault();
      confirmDiscard(() => navigation.dispatch(e.data.action));
    });
    return unsubscribe;
  }, [navigation, isDirty]);

  // Cancel button — confirm before discarding when there are unsaved changes.
  const confirmLeave = () => {
    if (!isDirty) {
      router.back();
      return;
    }
    confirmDiscard(() => router.back());
  };

  const handleSave = async () => {
    if (!invoice) return;
    setBanner(null);
    setLineErrors({});
    setIssueDateError(null);
    setDueDateError(null);

    if (!invoiceNumber.trim()) {
      setBanner("Enter an invoice number.");
      scrollToTop();
      return;
    }
    if (!issueDate.trim()) {
      setBanner("Enter an issue date.");
      scrollToTop();
      return;
    }
    // Normalize the submitted lines' numerics (comma→dot), flagging anything
    // non-finite/empty as an inline error. normalizeLines is pure and emits
    // exactly one payload line per description-bearing draft line, so its
    // payload length doubles as the "any lines left?" check.
    const { payloadLines, lineErrs } = normalizeLines(lines);
    if (linesDirty && payloadLines.length === 0) {
      setBanner("Keep at least one line item with a description.");
      scrollToTop();
      return;
    }

    // Inline date + numeric validation before any network call.
    let hasFieldError = false;
    if (!isValidISODate(issueDate.trim())) {
      setIssueDateError("Enter the issue date as YYYY-MM-DD.");
      hasFieldError = true;
    }
    if (dueDate.trim() && !isValidISODate(dueDate.trim())) {
      setDueDateError("Enter the due date as YYYY-MM-DD.");
      hasFieldError = true;
    }
    if (linesDirty && Object.keys(lineErrs).length > 0) {
      setLineErrors(lineErrs);
      hasFieldError = true;
    }
    if (hasFieldError) {
      setBanner("Fix the highlighted fields before saving.");
      scrollToTop();
      return;
    }

    try {
      // Party fixes first (a corrected TIN must be in place before any
      // re-validation/retry re-reads the parties). Requests are serialized —
      // the API applies audit + validation per call.
      if (supplierDraft && supplierQuery.data) {
        const patch = partyPatch(supplierDraft, supplierQuery.data);
        if (Object.keys(patch).length > 0) {
          await updateParty.mutateAsync({ id: supplierId, data: patch });
          await queryClient.invalidateQueries({
            queryKey: getGetPartyQueryKey(supplierId),
          });
        }
      }
      if (!buyerLocked && buyerDraft && buyerQuery.data) {
        const patch = partyPatch(buyerDraft, buyerQuery.data);
        if (Object.keys(patch).length > 0) {
          await updateParty.mutateAsync({ id: buyerId, data: patch });
          await queryClient.invalidateQueries({
            queryKey: getGetPartyQueryKey(buyerId),
          });
        }
      }

      const invPatch: {
        invoiceNumber?: string;
        issueDate?: string;
        dueDate?: string | null;
        notes?: string | null;
        lines?: InvoiceLineInput[];
      } = {};
      if (invoiceNumber.trim() !== invoice.invoiceNumber) {
        invPatch.invoiceNumber = invoiceNumber.trim();
      }
      if (issueDate.trim() !== invoice.issueDate) {
        invPatch.issueDate = issueDate.trim();
      }
      if (dueDate.trim() !== (invoice.dueDate ?? "")) {
        invPatch.dueDate = dueDate.trim() === "" ? null : dueDate.trim();
      }
      if (notes.trim() !== (invoice.notes ?? "")) {
        invPatch.notes = notes.trim() === "" ? null : notes.trim();
      }
      if (linesDirty) {
        invPatch.lines = payloadLines;
      }
      if (Object.keys(invPatch).length > 0) {
        await updateInvoice.mutateAsync({ id, data: invPatch });
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
      setBanner(
        apiErrorMessage(
          e,
          "We couldn't save these changes. Please try again.",
        ),
      );
      scrollToTop();
    }
  };

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Fix invoice details")} />
      <ScrollHost
        ref={scrollRef}
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
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
              edited. To correct it, issue a credit note from the MeridianIQ web
              console.
            </AppText>
          </Card>
        ) : (
          <View style={{ gap: 20 }}>
            {banner ? <Banner tone="error" message={banner} /> : null}

            {focus.length > 0 ? (
              <Card
                style={{
                  borderColor: colors.warning,
                  borderWidth: 1,
                }}
              >
                <AppText variant="label">
                  {focus.includes("parties")
                    ? "The rail rejected a tax identification number (TIN). Check the highlighted business details below, then retry."
                    : focus.includes("invoiceNumber")
                      ? "The rail flagged this invoice number as a duplicate. Change the invoice number below, then retry."
                      : "The rail rejected the invoice data. Check the highlighted invoice fields and line items, then retry."}
                </AppText>
              </Card>
            ) : null}

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
              title="Buyer"
              subtitle="Who the invoice is billed to"
              draft={buyerDraft}
              onChange={(p) =>
                setBuyerDraft((prev) => (prev ? { ...prev, ...p } : prev))
              }
              highlighted={focus.includes("parties")}
              locked={buyerLocked}
              lockedMessage="The buyer's registration details are managed by your accounting firm. If the buyer's TIN is wrong, ask your firm contact to correct it — then retry the transmission."
              loadFailed={buyerLoadFailed}
              loadFailedMessage="We couldn't load the buyer's details. Check your connection and try again."
              onRetry={() => void buyerQuery.refetch()}
            />

            <View style={{ gap: 8 }}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <AppText variant="heading">Invoice details</AppText>
                {focus.includes("invoice") || focus.includes("invoiceNumber") ? (
                  <Feather
                    name="alert-circle"
                    size={16}
                    color={colors.destructive}
                  />
                ) : null}
              </View>
              <Card
                style={{
                  gap: 12,
                  borderColor:
                    focus.includes("invoice") || focus.includes("invoiceNumber")
                      ? colors.destructive
                      : colors.border,
                  borderWidth:
                    focus.includes("invoice") || focus.includes("invoiceNumber")
                      ? 1
                      : StyleSheet.hairlineWidth,
                }}
              >
                <TextField
                  label="Invoice number"
                  value={invoiceNumber}
                  onChangeText={setInvoiceNumber}
                  placeholder="INV-0001"
                  autoCapitalize="characters"
                  hint={
                    focus.includes("invoiceNumber")
                      ? "Pick a number you haven't used before — the rail saw this one already."
                      : undefined
                  }
                />
                <TextField
                  label="Issue date"
                  value={issueDate}
                  onChangeText={(t) => {
                    setIssueDate(t);
                    if (issueDateError) setIssueDateError(null);
                  }}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                  error={issueDateError}
                />
                <TextField
                  label="Due date (optional)"
                  value={dueDate}
                  onChangeText={(t) => {
                    setDueDate(t);
                    if (dueDateError) setDueDateError(null);
                  }}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                  error={dueDateError}
                />
                <TextField
                  label="Notes (optional)"
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Payment terms, reference…"
                  multiline
                  style={{ height: 80, paddingTop: 12, textAlignVertical: "top" }}
                />
              </Card>
            </View>

            <View style={{ gap: 12 }}>
              <View style={rowBetween}>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <AppText variant="heading">Line items</AppText>
                  {focus.includes("lines") ? (
                    <Feather
                      name="alert-circle"
                      size={16}
                      color={colors.destructive}
                    />
                  ) : null}
                </View>
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
                  highlighted={focus.includes("lines")}
                />
              ))}
            </View>

            <TotalsCard totals={totals} />

            <AppButton
              label={saving ? "Saving…" : "Save changes"}
              icon="check"
              onPress={() => void handleSave()}
              loading={saving}
              disabled={saving}
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

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
});
