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
import { Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  ErrorState,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency } from "@/lib/format";

// Minimal handle we need from the scroll view — just the imperative scrollTo.
type Scrollable = {
  scrollTo?: (opts?: { x?: number; y?: number; animated?: boolean }) => void;
};

// React 19 forwards `ref` to function components as a prop, and the compat
// wrapper spreads its props onto the underlying ScrollView — so a ref set here
// reaches the real scroll view. The cast just teaches TS that this host accepts
// the ref (the wrapper's own prop types don't declare it).
const ScrollHost = KeyboardAwareScrollViewCompat as unknown as React.ComponentType<
  React.ComponentProps<typeof KeyboardAwareScrollViewCompat> & {
    ref?: React.Ref<Scrollable>;
  }
>;

// Per-line inline numeric errors, keyed by line.key.
type LineErrors = Record<string, { quantity?: string; unitPrice?: string }>;

// Parse a user-entered numeric string: trims, coerces a decimal comma to a dot,
// and returns a finite number or null.
function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// Validate a YYYY-MM-DD calendar date locally (rejects e.g. 2024-02-31).
function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

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

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string; // percent, e.g. "7.5"
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
    ? (buyerQuery.error as { status?: number } | null)?.status
    : undefined;
  const buyerLocked = buyerErrorStatus === 403;
  const buyerLoadFailed = buyerQuery.isError && !buyerLocked;

  // The supplier is the user's own party, so a 403 would still mean "managed by
  // your firm"; any other error is transient. Either way, don't leave the
  // supplier section stuck on an eternal skeleton — surface it.
  const supplierErrorStatus = supplierQuery.isError
    ? (supplierQuery.error as { status?: number } | null)?.status
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

  const totals = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const l of lines) {
      const ext = num(l.quantity) * num(l.unitPrice);
      subtotal += ext;
      vat += (ext * num(l.vatRate)) / 100;
    }
    return { subtotal, vat, grand: subtotal + vat };
  }, [lines]);

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
      {
        key: `new-${Date.now()}-${prev.length}`,
        description: "",
        quantity: "1",
        unitPrice: "",
        vatRate: "7.5",
      },
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

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || !isDirty) return;
      e.preventDefault();
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
              navigation.dispatch(e.data.action);
            },
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, isDirty]);

  // Cancel button — confirm before discarding when there are unsaved changes.
  const confirmLeave = () => {
    if (!isDirty) {
      router.back();
      return;
    }
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
            router.back();
          },
        },
      ],
    );
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
    const validLines = lines.filter((l) => l.description.trim());
    if (linesDirty && validLines.length === 0) {
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

    // Normalize each submitted line's numerics (comma→dot) and flag anything
    // non-finite/empty as an inline error.
    const lineErrs: LineErrors = {};
    const normalizedLines: InvoiceLineInput[] = validLines.map((l) => {
      const qty = parseNumeric(l.quantity);
      const price = parseNumeric(l.unitPrice);
      const rate = parseNumeric(l.vatRate) ?? 0;
      const errs: { quantity?: string; unitPrice?: string } = {};
      if (qty === null || qty <= 0) {
        errs.quantity = "Enter a quantity greater than 0.";
      }
      if (price === null || price < 0) {
        errs.unitPrice = "Enter a valid unit price.";
      }
      if (errs.quantity || errs.unitPrice) lineErrs[l.key] = errs;
      return {
        description: l.description.trim(),
        quantity: String(qty ?? 0),
        unitPrice: String(price ?? 0),
        vatRate: String(rate / 100),
      };
    });
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
        invPatch.lines = normalizedLines;
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
      const data =
        e && typeof e === "object" ? (e as { data?: unknown }).data : null;
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as { message?: unknown }).message)
          : e instanceof Error && e.message
            ? e.message
            : "We couldn't save these changes. Please try again.";
      setBanner(message);
      scrollToTop();
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Fix invoice details",
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTitleStyle: {
            fontFamily: "Inter_600SemiBold",
            color: colors.foreground,
          },
          headerTintColor: colors.primary,
        }}
      />
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
              <View style={styles.rowBetween}>
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

              {lines.map((line, index) => {
                const ext = num(line.quantity) * num(line.unitPrice);
                const lineErr = lineErrors[line.key];
                return (
                  <Card
                    key={line.key}
                    style={{
                      gap: 12,
                      borderColor: focus.includes("lines")
                        ? colors.destructive
                        : colors.border,
                      borderWidth: focus.includes("lines")
                        ? 1
                        : StyleSheet.hairlineWidth,
                    }}
                  >
                    <View style={styles.rowBetween}>
                      <AppText variant="label" color={colors.mutedForeground}>
                        Item {index + 1}
                      </AppText>
                      {lines.length > 1 ? (
                        <Pressable
                          onPress={() => removeLine(line.key)}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove line ${index + 1}`}
                          hitSlop={12}
                          style={styles.trashBtn}
                        >
                          <Feather
                            name="trash-2"
                            size={18}
                            color={colors.destructiveText}
                          />
                        </Pressable>
                      ) : null}
                    </View>
                    <TextField
                      label="Description"
                      value={line.description}
                      onChangeText={(t) =>
                        updateLine(line.key, { description: t })
                      }
                      placeholder="Consulting services"
                    />
                    <View style={{ flexDirection: "row", gap: 12 }}>
                      <View style={{ flex: 1 }}>
                        <TextField
                          label="Qty"
                          value={line.quantity}
                          onChangeText={(t) =>
                            updateLine(line.key, { quantity: t })
                          }
                          keyboardType="decimal-pad"
                          placeholder="1"
                          error={lineErr?.quantity}
                        />
                      </View>
                      <View style={{ flex: 1.4 }}>
                        <TextField
                          label="Unit price"
                          value={line.unitPrice}
                          onChangeText={(t) =>
                            updateLine(line.key, { unitPrice: t })
                          }
                          keyboardType="decimal-pad"
                          placeholder="0.00"
                          error={lineErr?.unitPrice}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <TextField
                          label="VAT %"
                          value={line.vatRate}
                          onChangeText={(t) =>
                            updateLine(line.key, { vatRate: t })
                          }
                          keyboardType="decimal-pad"
                          placeholder="7.5"
                        />
                      </View>
                    </View>
                    <View style={styles.rowBetween}>
                      <AppText variant="caption" color={colors.mutedForeground}>
                        Line total
                      </AppText>
                      <AppText variant="label">{formatCurrency(ext)}</AppText>
                    </View>
                  </Card>
                );
              })}
            </View>

            <Card style={{ gap: 8, backgroundColor: colors.secondary }}>
              <View style={styles.rowBetween}>
                <AppText variant="body" color={colors.mutedForeground}>
                  Subtotal
                </AppText>
                <AppText variant="body">
                  {formatCurrency(totals.subtotal)}
                </AppText>
              </View>
              <View style={styles.rowBetween}>
                <AppText variant="body" color={colors.mutedForeground}>
                  VAT
                </AppText>
                <AppText variant="body">{formatCurrency(totals.vat)}</AppText>
              </View>
              <Divider />
              <View style={styles.rowBetween}>
                <AppText variant="heading">Total</AppText>
                <AppText variant="heading" color={colors.primary}>
                  {formatCurrency(totals.grand)}
                </AppText>
              </View>
            </Card>

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
    ...(Platform.OS === "web"
      ? { maxWidth: 640, alignSelf: "center", width: "100%" }
      : {}),
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  trashBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
