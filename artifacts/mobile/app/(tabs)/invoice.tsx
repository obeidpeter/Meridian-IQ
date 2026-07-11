import { Feather } from "@expo/vector-icons";
import {
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
import React, { useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
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
  const [banner, setBanner] = useState<
    { tone: "error" | "success"; message: string } | null
  >(null);

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
  };

  const errorFor = (field: string): string | undefined =>
    fieldErrors.find((e) => e.field === field || e.field.endsWith(field))
      ?.message;

  const validateLocal = (): string | null => {
    if (!clientPartyId) return "No client selected.";
    if (!buyerPartyId) return "Choose a buyer for this invoice.";
    if (!invoiceNumber.trim()) return "Enter an invoice number.";
    if (!issueDate.trim()) return "Enter an issue date.";
    const hasValidLine = lines.some(
      (l) => l.description.trim() && num(l.unitPrice) > 0,
    );
    if (!hasValidLine)
      return "Add at least one line item with a description and price.";
    return null;
  };

  const handleSubmit = async () => {
    setBanner(null);
    setFieldErrors([]);

    const localError = validateLocal();
    if (localError) {
      setBanner({ tone: "error", message: localError });
      return;
    }

    const payloadLines: InvoiceLineInput[] = lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: l.quantity || "0",
        unitPrice: l.unitPrice || "0",
        vatRate: l.vatRate || "0",
      }));

    try {
      const created = await createInvoice.mutateAsync({
        data: {
          supplierPartyId: clientPartyId!,
          buyerPartyId: buyerPartyId!,
          invoiceNumber: invoiceNumber.trim(),
          issueDate,
          kind: InvoiceInputKind.invoice,
          category: InvoiceInputCategory.b2b,
          notes: notes.trim() || undefined,
          lines: payloadLines,
        },
      });

      const invoiceId = created.invoice.id;

      const validation = await validateInvoice.mutateAsync({ id: invoiceId });
      if (!validation.ok) {
        setFieldErrors(validation.errors);
        setBanner({
          tone: "error",
          message:
            "This invoice needs changes before it can be submitted. Review the flagged fields.",
        });
        return;
      }

      await submitInvoice.mutateAsync({ id: invoiceId });

      await queryClient.invalidateQueries();
      setBanner({
        tone: "success",
        message: `Invoice ${created.invoice.invoiceNumber} submitted for fiscalisation.`,
      });
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
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 120 },
      ]}
      bottomOffset={20}
    >
      {banner ? (
        <Card
          style={{
            backgroundColor:
              banner.tone === "success" ? colors.accent : colors.destructive,
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <Feather
              name={banner.tone === "success" ? "check-circle" : "alert-triangle"}
              size={18}
              color={banner.tone === "success" ? colors.accentForeground : "#ffffff"}
            />
            <AppText
              variant="label"
              color={banner.tone === "success" ? colors.accentForeground : "#ffffff"}
              style={{ flex: 1 }}
            >
              {banner.message}
            </AppText>
          </View>
        </Card>
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
            <View style={{ gap: 8 }}>
              {buyers.map((buyer) => {
                const selected = buyer.id === buyerPartyId;
                return (
                  <Pressable
                    key={buyer.id}
                    onPress={() => setBuyerPartyId(buyer.id)}
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
            <AppText variant="caption" color={colors.destructive}>
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
          onChangeText={setIssueDate}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          error={errorFor("issueDate")}
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
            return (
              <Card key={line.key} style={{ gap: 12 }}>
                <View style={styles.rowBetween}>
                  <AppText variant="label" color={colors.mutedForeground}>
                    Item {index + 1}
                  </AppText>
                  {lines.length > 1 ? (
                    <Pressable onPress={() => removeLine(line.key)}>
                      <Feather name="trash-2" size={18} color={colors.destructive} />
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
                    />
                  </View>
                  <View style={{ flex: 1.4 }}>
                    <TextField
                      label="Unit price"
                      value={line.unitPrice}
                      onChangeText={(t) => updateLine(line.key, { unitPrice: t })}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
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
                <Badge label={e.field} tone="critical" />
                <AppText variant="caption" color={colors.destructive} style={{ flex: 1 }}>
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
    </KeyboardAwareScrollViewCompat>
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
});
