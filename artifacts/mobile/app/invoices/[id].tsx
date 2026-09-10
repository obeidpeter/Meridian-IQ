import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { InvoiceSummaryCard } from "@/components/invoice-detail/invoice-summary-card";
import { LineItemsCard } from "@/components/invoice-detail/line-items-card";
import { StatusLightCard } from "@/components/invoice-detail/status-light-card";
import { TransmissionFailedCard } from "@/components/invoice-detail/transmission-failed-card";
import { TransmissionHistory } from "@/components/invoice-detail/transmission-history";
import {
  AppButton,
  AppText,
  Banner,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorState,
  screenContent,
  ScreenScroll,
  stackHeaderOptions,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useInvoiceDetail } from "@/hooks/useInvoiceDetail";
import { errorStatus } from "@/lib/api-error";

export default function InvoiceDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === "string" ? rawId : "";
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    detailQuery,
    attemptsQuery,
    statusLightQuery,
    invoice,
    lines,
    attempts,
    errorCode,
    catalogue,
    banner,
    onRefresh,
    busy,
    handleSubmit,
    isFailed,
    canSubmit,
    retriableKnown,
    goToFix,
  } = useInvoiceDetail(id);

  return (
    <>
      <Stack.Screen
        options={stackHeaderOptions(
          colors,
          invoice ? invoice.invoiceNumber : "Invoice",
        )}
      />
      <ScreenScroll
        contentContainerStyle={[
          screenContent,
          { paddingBottom: insets.bottom + 40 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={detailQuery.isRefetching || attemptsQuery.isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {detailQuery.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={2} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={3} />
          </View>
        ) : detailQuery.isError ? (
          errorStatus(detailQuery.error) === 404 ? (
            <EmptyState
              icon="file"
              title="We couldn't find this invoice"
              message="It may have been removed, or the link may be out of date."
            />
          ) : (
            <ErrorState
              message="We couldn't load this invoice."
              onRetry={onRefresh}
            />
          )
        ) : invoice ? (
          <View style={{ gap: 16 }}>
            {banner ? (
              <Banner tone={banner.tone} message={banner.message} />
            ) : null}

            <InvoiceSummaryCard invoice={invoice} />

            <StatusLightCard query={statusLightQuery} />

            {isFailed ? (
              <TransmissionFailedCard
                catalogue={catalogue}
                errorCode={errorCode}
                retriableKnown={retriableKnown}
                busy={busy}
                onRetry={handleSubmit}
                onFix={goToFix}
              />
            ) : null}

            {canSubmit ? (
              <AppButton
                label={busy ? "Submitting…" : "Submit for stamping"}
                icon="send"
                onPress={handleSubmit}
                loading={busy}
                disabled={busy}
                testID="button-submit-invoice"
              />
            ) : null}

            <LineItemsCard lines={lines} grandTotal={invoice.grandTotal} />

            <TransmissionHistory
              attempts={attempts}
              loading={attemptsQuery.isLoading}
            />

            {invoice.notes ? (
              <View style={{ gap: 8 }}>
                <AppText variant="heading">Notes</AppText>
                <Card>
                  <AppText variant="body" color={colors.mutedForeground}>
                    {invoice.notes}
                  </AppText>
                </Card>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScreenScroll>
    </>
  );
}
