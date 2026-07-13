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
  InvoiceLineInput,
  Party,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
  Banner,
  Card,
  Divider,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency } from "@/lib/format";
import { useSession } from "@/lib/session";

const DEFAULT_VAT_RATE = "7.5";

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

// Per-line inline numeric errors, keyed by line.key.
type LineErrors = Record<string, { quantity?: string; unitPrice?: string }>;

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

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Parse a user-entered numeric string: trims, coerces a decimal comma to a dot
// (common on many locales/keyboards), and returns a finite number or null.
function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// Validate a YYYY-MM-DD calendar date locally (rejects e.g. 2024-02-31) so the
// user gets immediate feedback instead of a server round-trip.
function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
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
  const router = useRouter();
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

  const totals = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const line of lines) {
      const ext = num(line.quantity) * num(line.unitPrice);
      subtotal += ext;
      vat += (ext * num(line.vatRate)) / 100;
    }
    return { subtotal, vat, grand: subtotal + vat };
  }, [lines]);

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

  // Build the API line payload from normalized numerics and collect per-line
  // inline errors for anything non-finite/empty.
  const buildPayloadLines = (): {
    payloadLines: InvoiceLineInput[];
    lineErrs: LineErrors;
  } => {
    const lineErrs: LineErrors = {};
    const payloadLines: InvoiceLineInput[] = [];
    for (const l of lines) {
      if (!l.description.trim()) continue;
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
      payloadLines.push({
        description: l.description.trim(),
        quantity: String(qty ?? 0),
        unitPrice: String(price ?? 0),
        vatRate: String(rate / 100),
      });
    }
    return { payloadLines, lineErrs };
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
      const { payloadLines, lineErrs } = buildPayloadLines();
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

          {lines.map((line, index) => {
            const ext = num(line.quantity) * num(line.unitPrice);
            const lineErr = lineErrors[line.key];
            return (
              <Card key={line.key} style={{ gap: 12 }}>
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
                      <Feather name="trash-2" size={18} color={colors.destructiveText} />
                    </Pressable>
                  ) : null}
                </View>
                <TextField
                  label="Description"
                  value={line.description}
                  onChangeText={(t) => updateLine(line.key, { description: t })}
                  placeholder="Consulting services"
                />
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <TextField
                      label="Qty"
                      value={line.quantity}
                      onChangeText={(t) => updateLine(line.key, { quantity: t })}
                      keyboardType="decimal-pad"
                      placeholder="1"
                      error={lineErr?.quantity}
                    />
                  </View>
                  <View style={{ flex: 1.4 }}>
                    <TextField
                      label="Unit price"
                      value={line.unitPrice}
                      onChangeText={(t) => updateLine(line.key, { unitPrice: t })}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      error={lineErr?.unitPrice}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TextField
                      label="VAT %"
                      value={line.vatRate}
                      onChangeText={(t) => updateLine(line.key, { vatRate: t })}
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

        <TextField
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Payment terms, reference…"
          multiline
          style={{ height: 80, paddingTop: 12, textAlignVertical: "top" }}
        />

        <Card style={{ gap: 8, backgroundColor: colors.secondary }}>
          <View style={styles.rowBetween}>
            <AppText variant="body" color={colors.mutedForeground}>
              Subtotal
            </AppText>
            <AppText variant="body">{formatCurrency(totals.subtotal)}</AppText>
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
