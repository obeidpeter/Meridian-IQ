import { Feather } from "@expo/vector-icons";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getListInvoicesQueryKey,
  InvoiceInputCategory,
  InvoiceInputKind,
  PartyType,
  useCreateInvoice,
  useListParties,
  useSubmitInvoice,
  useValidateInvoice,
} from "@workspace/api-client-react";
import type {
  FieldError,
  Party,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LineItemCard, TotalsCard } from "@/components/invoice-line-editor";
import { ScrollHost } from "@/components/KeyboardAwareScrollViewCompat";
import type { Scrollable } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
  Banner,
  Card,
  rowBetween,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  computeTotals,
  isValidISODate,
  normalizeLines,
  parseNumeric,
} from "@/lib/invoice-form";
import type { LineDraft, LineErrors } from "@/lib/invoice-form";
import { useSession } from "@/lib/session";

const DEFAULT_VAT_RATE = "7.5";

let lineCounter = 0;
function newLine(): LineDraft {
  lineCounter += 1;
  return {
    key: `line-${lineCounter}`,
    description: "",
    quantity: "1",
    unitPrice: "",
    vatRate: DEFAULT_VAT_RATE,
  };
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
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { clientPartyId } = useSession();

  const parties = useListParties();
  const createInvoice = useCreateInvoice();
  const validateInvoice = useValidateInvoice();
  const submitInvoice = useSubmitInvoice();

  const [buyerPartyId, setBuyerPartyId] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [lineErrors, setLineErrors] = useState<LineErrors>({});
  const [dateError, setDateError] = useState<string | null>(null);
  const [banner, setBanner] = useState<
    { tone: "error" | "success"; message: string } | null
  >(null);

  // Remembers the draft created on a prior (failed) attempt so a retry resumes
  // at validate→submit instead of creating a DUPLICATE invoice.
  const draftIdRef = useRef<string | null>(null);
  // Synchronous re-entrancy guard: a double-tap in the same frame can fire
  // before React commits the disabled prop, so guard here too.
  const submittingRef = useRef(false);
  const scrollRef = useRef<Scrollable | null>(null);

  const scrollToTop = () => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  };

  const buyers: Party[] = (parties.data ?? []).filter(
    (p) => p.type === PartyType.buyer,
  );

  const totals = useMemo(() => computeTotals(lines), [lines]);

  const busy =
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

  const resetForm = () => {
    setBuyerPartyId(null);
    setInvoiceNumber("");
    setIssueDate(todayISO());
    setNotes("");
    setLines([newLine()]);
    setFieldErrors([]);
    setLineErrors({});
    setDateError(null);
    // A fresh form means a fresh invoice.
    draftIdRef.current = null;
  };

  const errorFor = (field: string): string | undefined =>
    fieldErrors.find((e) => e.field === field || e.field.endsWith(field))
      ?.message;

  const validateLocal = (): string | null => {
    if (!clientPartyId) return "No client selected.";
    if (!buyerPartyId) return "Choose a buyer for this invoice.";
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
    if (submittingRef.current) return;
    submittingRef.current = true;
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
        // Resume an existing draft if we created one on a prior attempt;
        // otherwise create it now. This is what keeps a retry idempotent.
        let invoiceId = draftIdRef.current;
        let invoiceNumberForMessage = invoiceNumber.trim();
        if (!invoiceId) {
          const created = await createInvoice.mutateAsync({
            data: {
              supplierPartyId: clientPartyId!,
              buyerPartyId: buyerPartyId!,
              invoiceNumber: invoiceNumber.trim(),
              issueDate: issueDate.trim(),
              kind: InvoiceInputKind.invoice,
              category: InvoiceInputCategory.b2b,
              notes: notes.trim() || undefined,
              lines: payloadLines,
            },
          });
          invoiceId = created.invoice.id;
          invoiceNumberForMessage = created.invoice.invoiceNumber;
          draftIdRef.current = invoiceId;
        }

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
        draftIdRef.current = null;
        resetForm();
      } catch (error) {
        const data =
          error && typeof error === "object"
            ? (error as { data?: unknown }).data
            : null;
        if (data && typeof data === "object") {
          const errs = (data as { errors?: unknown }).errors;
          if (Array.isArray(errs)) setFieldErrors(errs as FieldError[]);
        }
        const message =
          data && typeof data === "object" && "message" in data
            ? String((data as { message?: unknown }).message)
            : "We couldn't submit this invoice. Please try again.";
        setBanner({ tone: "error", message });
        scrollToTop();
        // If a draft was created before the failure, keep its id (so the next
        // tap resumes rather than duplicates) and refresh the lists.
        if (draftIdRef.current) await invalidateInvoiceQueries();
      }
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <ScrollHost
      ref={scrollRef}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 120 },
      ]}
      bottomOffset={20}
    >
      {banner ? (
        <View style={{ marginBottom: 16 }}>
          <Banner tone={banner.tone} message={banner.message} />
        </View>
      ) : null}

      <View style={{ gap: 16 }}>
        <View style={{ gap: 8 }}>
          <AppText variant="heading">Buyer</AppText>
          {parties.isLoading ? (
            <AppText variant="body" color={colors.mutedForeground}>
              Loading buyers…
            </AppText>
          ) : buyers.length === 0 ? (
            <Card>
              <AppText variant="body" color={colors.mutedForeground}>
                No buyers found. Add a buyer in the console before invoicing.
              </AppText>
            </Card>
          ) : (
            <View
              style={{ gap: 8 }}
              accessibilityRole="radiogroup"
              accessibilityLabel="Buyer"
            >
              {buyers.map((buyer) => {
                const selected = buyer.id === buyerPartyId;
                return (
                  <Pressable
                    key={buyer.id}
                    onPress={() => setBuyerPartyId(buyer.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={
                      buyer.tin
                        ? `${buyer.legalName}, TIN ${buyer.tin}`
                        : buyer.legalName
                    }
                  >
                    <Card
                      style={{
                        borderColor: selected ? colors.primary : colors.border,
                        borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                      }}
                    >
                      <View style={styles.rowBetween}>
                        <View style={{ flex: 1 }}>
                          <AppText variant="label">{buyer.legalName}</AppText>
                          {buyer.tin ? (
                            <AppText variant="caption" color={colors.mutedForeground}>
                              TIN {buyer.tin}
                            </AppText>
                          ) : null}
                        </View>
                        {selected ? (
                          <Feather name="check-circle" size={20} color={colors.primary} />
                        ) : (
                          <Feather name="circle" size={20} color={colors.mutedForeground} />
                        )}
                      </View>
                    </Card>
                  </Pressable>
                );
              })}
            </View>
          )}
          {errorFor("buyerPartyId") ? (
            <AppText variant="caption" color={colors.destructiveText}>
              {errorFor("buyerPartyId")}
            </AppText>
          ) : null}
        </View>

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
          <View style={styles.rowBetween}>
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
              <View key={`${e.field}-${i}`} style={{ flexDirection: "row", gap: 6 }}>
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
          disabled={busy}
        />
        <AppButton
          label="Reset form"
          variant="ghost"
          icon="rotate-ccw"
          onPress={resetForm}
          disabled={busy}
        />
      </View>
    </ScrollHost>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
  rowBetween: { ...rowBetween },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
});
