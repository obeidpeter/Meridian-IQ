import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPayablesSummaryQueryKey,
  getListBillsQueryKey,
  useFlagBillPayment,
  useListBills,
  useVerifyBillStamp,
} from "@workspace/api-client-react";
import type {
  BillSummary,
  BillVerification,
} from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  rowBetween,
  stackHeaderOptions,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage } from "@/lib/api-error";
import {
  billStatusLabel,
  billStatusTone,
  canFlag,
  verificationChip,
  type BillFlagTarget,
} from "@/lib/bills";
import { formatCurrency, formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";

// The confirm copy is the page's load-bearing promise: a payment flag records
// settlement evidence on the bill, it never mutates the captured document.
const FLAG_CONFIRM_MESSAGE =
  "This records payment evidence on the bill — it never edits the document.";

function flagConfirmTitle(target: BillFlagTarget): string {
  return target === "paid" ? "Mark this bill paid?" : "Mark payment scheduled?";
}

function billAmount(bill: BillSummary): string {
  return bill.currency === "NGN"
    ? formatCurrency(bill.grandTotal)
    : `${bill.currency} ${bill.grandTotal}`;
}

// Inline IRN+CSID verification against the national record. Local state on
// purpose: collapsing a row discards a half-typed form, and each expanded row
// keeps its own last result.
function VerifyStampForm({
  bill,
  isPending,
  onVerify,
}: {
  bill: BillSummary;
  isPending: boolean;
  onVerify: (irn: string, csid: string) => Promise<BillVerification>;
}) {
  const [irn, setIrn] = useState("");
  const [csid, setCsid] = useState("");
  const [result, setResult] = useState<BillVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await onVerify(irn.trim(), csid.trim()));
    } catch (e) {
      setError(
        apiErrorMessage(e, "We couldn't check that stamp. Please try again."),
      );
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <AppText variant="label">Verify stamp</AppText>
      <TextField
        label="IRN"
        value={irn}
        onChangeText={setIrn}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={120}
        testID={`input-verify-irn-${bill.invoiceId}`}
      />
      <TextField
        label="CSID"
        value={csid}
        onChangeText={setCsid}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={120}
        hint="From the supplier's stamped invoice"
        testID={`input-verify-csid-${bill.invoiceId}`}
      />
      <AppButton
        label={isPending ? "Checking…" : "Verify stamp"}
        icon="shield"
        variant="secondary"
        onPress={() => void submit()}
        disabled={!irn.trim() || !csid.trim() || isPending}
        loading={isPending}
        testID={`button-verify-bill-${bill.invoiceId}`}
      />
      {result ? (
        <Banner
          tone={result.valid ? "success" : "error"}
          message={
            result.valid ? "Valid stamp" : "Not found on the national record"
          }
        />
      ) : null}
      {error ? <Banner tone="error" message={error} /> : null}
    </View>
  );
}

function BillCard({
  bill,
  expanded,
  onToggle,
  onFlag,
  flagPending,
  verifyPending,
  onVerify,
}: {
  bill: BillSummary;
  expanded: boolean;
  onToggle: () => void;
  onFlag: (target: BillFlagTarget) => void;
  flagPending: boolean;
  verifyPending: boolean;
  onVerify: (irn: string, csid: string) => Promise<BillVerification>;
}) {
  const colors = useColors();
  const chip = verificationChip(bill.lastVerification);
  const a11yLabel = [
    `Bill ${bill.invoiceNumber}`,
    bill.supplierName,
    billStatusLabel(bill.payStatus),
    chip?.label,
    billAmount(bill),
    `Issued ${formatDate(bill.issueDate)}`,
    bill.dueDate ? `Due ${formatDate(bill.dueDate)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Card style={{ gap: 10 }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityState={{ expanded }}
        accessibilityHint={
          expanded ? "Collapses bill actions" : "Expands bill actions"
        }
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        testID={`bill-item-${bill.invoiceId}`}
      >
        <View style={rowBetween}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <View style={styles.inlineRow}>
              <AppText
                variant="label"
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {bill.invoiceNumber}
              </AppText>
              <Badge
                label={billStatusLabel(bill.payStatus)}
                tone={billStatusTone(bill.payStatus)}
              />
              {chip ? <Badge label={chip.label} tone={chip.tone} /> : null}
            </View>
            <AppText
              variant="caption"
              color={colors.mutedForeground}
              numberOfLines={1}
              style={{ marginTop: 4 }}
            >
              {bill.supplierName} · Issued {formatDate(bill.issueDate)}
              {bill.dueDate ? ` · Due ${formatDate(bill.dueDate)}` : ""}
            </AppText>
          </View>
          <View style={styles.inlineRow}>
            <AppText variant="label">{billAmount(bill)}</AppText>
            <Feather
              name={expanded ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.mutedForeground}
            />
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <>
          <Divider />
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <AppButton
                  label="Mark scheduled"
                  icon="clock"
                  variant="secondary"
                  onPress={() => onFlag("scheduled")}
                  disabled={
                    !canFlag(bill.payStatus, "scheduled") || flagPending
                  }
                  testID={`button-flag-scheduled-${bill.invoiceId}`}
                />
              </View>
              <View style={{ flex: 1 }}>
                <AppButton
                  label="Mark paid"
                  icon="check"
                  onPress={() => onFlag("paid")}
                  disabled={!canFlag(bill.payStatus, "paid") || flagPending}
                  loading={flagPending}
                  testID={`button-flag-paid-${bill.invoiceId}`}
                />
              </View>
            </View>
            {bill.payStatus === "paid" ? (
              <AppText variant="caption" color={colors.mutedForeground}>
                Payment recorded — nothing more to flag on this bill.
              </AppText>
            ) : null}
            <VerifyStampForm
              bill={bill}
              isPending={verifyPending}
              onVerify={onVerify}
            />
          </View>
        </>
      ) : null}
    </Card>
  );
}

export default function BillsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { clientPartyId } = useSession();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const billsQuery = useListBills(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListBillsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
        retry: false,
      },
    },
  );

  const flagMut = useFlagBillPayment();
  const verifyMut = useVerifyBillStamp();

  const bills = billsQuery.data ?? [];

  const refreshBills = useCallback(() => {
    // Prefix keys: every param variant of the list and the payables summary
    // go stale together.
    void queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: getGetPayablesSummaryQueryKey(),
    });
  }, [queryClient]);

  const runFlag = useCallback(
    async (bill: BillSummary, target: BillFlagTarget) => {
      setBanner(null);
      try {
        await flagMut.mutateAsync({
          id: bill.invoiceId,
          data: { status: target },
        });
        refreshBills();
        setBanner({
          tone: "success",
          message: `Payment evidence recorded — ${bill.invoiceNumber} is ${
            target === "paid" ? "marked paid" : "scheduled for payment"
          }.`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(
            error,
            "We couldn't record that payment flag. Please try again.",
          ),
        });
      }
    },
    [flagMut, refreshBills],
  );

  const confirmFlag = useCallback(
    (bill: BillSummary, target: BillFlagTarget) => {
      // Alert.alert is a no-op on react-native-web, so fall back to the
      // browser's native confirm there (same pattern as bulk submit).
      if (Platform.OS === "web") {
        if (
          window.confirm(`${flagConfirmTitle(target)}\n\n${FLAG_CONFIRM_MESSAGE}`)
        ) {
          void runFlag(bill, target);
        }
        return;
      }
      Alert.alert(flagConfirmTitle(target), FLAG_CONFIRM_MESSAGE, [
        { text: "Cancel", style: "cancel" },
        {
          text: target === "paid" ? "Mark paid" : "Mark scheduled",
          onPress: () => void runFlag(bill, target),
        },
      ]);
    },
    [runFlag],
  );

  const runVerify = useCallback(
    async (
      bill: BillSummary,
      irn: string,
      csid: string,
    ): Promise<BillVerification> => {
      const result = await verifyMut.mutateAsync({
        id: bill.invoiceId,
        data: { irn, csid },
      });
      // The row chip refreshes from the server's stored result.
      refreshBills();
      return result;
    },
    [verifyMut, refreshBills],
  );

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Supplier bills")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 48 },
        ]}
        bottomOffset={20}
        refreshControl={
          <RefreshControl
            refreshing={billsQuery.isRefetching}
            onRefresh={() => void billsQuery.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        {billsQuery.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </View>
        ) : billsQuery.isError ? (
          <ErrorState
            message="We couldn't load your supplier bills."
            onRetry={() => void billsQuery.refetch()}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <AppText variant="body" color={colors.mutedForeground}>
              Documents you captured where your business is the buyer — money
              going out.
            </AppText>

            {banner ? (
              <Banner tone={banner.tone} message={banner.message} />
            ) : null}

            {bills.length === 0 ? (
              <EmptyState
                icon="inbox"
                title="No supplier bills yet"
                message="Documents you send to Clerk where you are the buyer will show up here."
              />
            ) : (
              bills.map((bill) => (
                <BillCard
                  key={bill.invoiceId}
                  bill={bill}
                  expanded={expandedId === bill.invoiceId}
                  onToggle={() =>
                    setExpandedId((prev) =>
                      prev === bill.invoiceId ? null : bill.invoiceId,
                    )
                  }
                  onFlag={(target) => confirmFlag(bill, target)}
                  flagPending={flagMut.isPending}
                  verifyPending={verifyMut.isPending}
                  onVerify={(irn, csid) => runVerify(bill, irn, csid)}
                />
              ))
            )}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
