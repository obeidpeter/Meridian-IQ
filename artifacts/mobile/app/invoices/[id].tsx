import { Feather } from "@expo/vector-icons";
import {
  getGetErrorCatalogueEntryQueryKey,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  useGetErrorCatalogueEntry,
  useGetInvoice,
  useListSubmissionAttempts,
  useSubmitInvoice,
  useValidateInvoice,
} from "@workspace/api-client-react";
import type {
  InvoiceStatus,
  SubmissionAttempt,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppButton,
  AppText,
  Badge,
  BadgeTone,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  formatCurrency,
  formatDate,
  humanize,
  timeAgo,
} from "@/lib/format";

// Mirrors the web vault's status tones so both clients tell the same story.
const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: "neutral",
  validated: "info",
  submitted: "warning",
  stamped: "success",
  confirmed: "success",
  settled: "success",
  failed: "critical",
  cancelled: "neutral",
  credited: "neutral",
};

const ATTEMPT_ICON: Record<
  string,
  { icon: keyof typeof Feather.glyphMap; toneKey: "success" | "critical" | "muted" }
> = {
  accepted: { icon: "check-circle", toneKey: "success" },
  stamped: { icon: "check-circle", toneKey: "success" },
  pending: { icon: "clock", toneKey: "muted" },
  submitted: { icon: "clock", toneKey: "muted" },
  rejected: { icon: "x-circle", toneKey: "critical" },
  error: { icon: "x-circle", toneKey: "critical" },
};

function attemptFailed(a: SubmissionAttempt): boolean {
  return a.status === "rejected" || a.status === "error";
}

export default function InvoiceDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === "string" ? rawId : "";
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const router = useRouter();

  const detailQuery = useGetInvoice(id, {
    // A deleted or stale deep-linked invoice 404s — don't retry before we can
    // show the EmptyState.
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id), retry: false },
  });
  const attemptsQuery = useListSubmissionAttempts(id, {
    query: { enabled: !!id, queryKey: getListSubmissionAttemptsQueryKey(id) },
  });

  const invoice = detailQuery.data?.invoice;
  const lines = detailQuery.data?.lines ?? [];
  const attempts = [...(attemptsQuery.data ?? [])].sort(
    (a, b) => b.attemptNo - a.attemptNo,
  );

  const latestFailed = attempts.filter(
    (a) => attemptFailed(a) && a.errorCode,
  )[0];
  const errorCode = latestFailed?.errorCode ?? undefined;
  const catalogueQuery = useGetErrorCatalogueEntry(errorCode ?? "", {
    query: {
      enabled: !!errorCode && invoice?.status === "failed",
      queryKey: getGetErrorCatalogueEntryQueryKey(errorCode ?? ""),
    },
  });
  const catalogue = catalogueQuery.data;

  const validate = useValidateInvoice();
  const submit = useSubmitInvoice();
  const [banner, setBanner] = useState<
    { tone: "error" | "success"; message: string } | null
  >(null);

  const refreshInvoice = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
    void queryClient.invalidateQueries({
      queryKey: getListSubmissionAttemptsQueryKey(id),
    });
  }, [queryClient, id]);

  const onRefresh = useCallback(() => {
    void detailQuery.refetch();
    void attemptsQuery.refetch();
  }, [detailQuery, attemptsQuery]);

  const busy = validate.isPending || submit.isPending;

  const handleSubmit = useCallback(async () => {
    if (!invoice) return;
    setBanner(null);
    try {
      if (invoice.status === "draft") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          refreshInvoice();
          setBanner({
            tone: "error",
            message:
              res.errors[0]?.message ||
              "This invoice needs changes before it can be submitted.",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      refreshInvoice();
      setBanner({
        tone: "success",
        message:
          invoice.status === "failed"
            ? "Retry accepted — the invoice is back on the rail. We'll notify you once it clears."
            : "Submitted for stamping. We'll notify you once it clears the rail.",
      });
    } catch (e) {
      const data =
        e && typeof e === "object" ? (e as { data?: unknown }).data : null;
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as { message?: unknown }).message)
          : e instanceof Error && e.message
            ? e.message
            : "We couldn't submit this invoice. Please try again.";
      setBanner({ tone: "error", message });
    }
  }, [invoice, id, validate, submit, refreshInvoice]);

  const isFailed = invoice?.status === "failed";
  const canSubmit =
    invoice?.status === "draft" || invoice?.status === "validated";
  const retriableKnown = catalogue ? catalogue.retriable : true;

  const goToFix = useCallback(() => {
    router.push({
      pathname: "/invoices/edit/[id]",
      params: { id, ...(errorCode ? { code: errorCode } : {}) },
    });
  }, [router, id, errorCode]);

  return (
    <>
      <Stack.Screen
        options={{
          title: invoice ? invoice.invoiceNumber : "Invoice",
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTitleStyle: {
            fontFamily: "Inter_600SemiBold",
            color: colors.foreground,
          },
          headerTintColor: colors.primary,
        }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 40 },
        ]}
        showsVerticalScrollIndicator={false}
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
          (detailQuery.error as { status?: number } | null)?.status === 404 ? (
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

            <Card>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <AppText variant="title">{invoice.invoiceNumber}</AppText>
                  <AppText
                    variant="caption"
                    color={colors.mutedForeground}
                    style={{ marginTop: 4 }}
                  >
                    Issued {formatDate(invoice.issueDate)}
                    {invoice.dueDate
                      ? ` · Due ${formatDate(invoice.dueDate)}`
                      : ""}
                  </AppText>
                </View>
                <Badge
                  label={humanize(invoice.status)}
                  tone={STATUS_TONE[invoice.status]}
                />
              </View>
              <Divider />
              <View style={[styles.rowBetween, { marginTop: 4 }]}>
                <AppText variant="body" color={colors.mutedForeground}>
                  Total
                </AppText>
                <AppText variant="heading" color={colors.primary}>
                  {formatCurrency(invoice.grandTotal)}
                </AppText>
              </View>
            </Card>

            {isFailed ? (
              <Card
                style={{
                  borderColor: colors.destructiveText,
                  borderWidth: 1,
                }}
              >
                <View style={styles.bannerRow}>
                  <Feather
                    name="alert-triangle"
                    size={18}
                    color={colors.destructiveText}
                  />
                  <AppText variant="heading" color={colors.destructiveText}>
                    Transmission failed
                  </AppText>
                </View>
                {catalogue ? (
                  <View style={{ marginTop: 12, gap: 10 }}>
                    <View>
                      <AppText variant="label">What went wrong</AppText>
                      <AppText
                        variant="body"
                        color={colors.mutedForeground}
                        style={{ marginTop: 2 }}
                      >
                        {catalogue.cause}
                      </AppText>
                    </View>
                    <View>
                      <AppText variant="label">How to fix it</AppText>
                      <AppText
                        variant="body"
                        color={colors.mutedForeground}
                        style={{ marginTop: 2 }}
                      >
                        {catalogue.fix}
                      </AppText>
                    </View>
                  </View>
                ) : (
                  <AppText
                    variant="body"
                    color={colors.mutedForeground}
                    style={{ marginTop: 10 }}
                  >
                    This invoice was rejected by the rail
                    {errorCode ? ` (code ${errorCode})` : ""}. You can retry
                    the transmission below.
                  </AppText>
                )}
                {errorCode ? (
                  <AppText
                    variant="caption"
                    color={colors.mutedForeground}
                    style={{ marginTop: 10 }}
                  >
                    Reference code: {errorCode}
                    {catalogue
                      ? catalogue.retriable
                        ? " · retriable"
                        : " · not retriable"
                      : ""}
                  </AppText>
                ) : null}
                <View style={{ marginTop: 14, gap: 10 }}>
                  {/* Non-retriable errors need the data fixed first, so the
                      fix flow leads and a blind retry is demoted. */}
                  {retriableKnown ? (
                    <>
                      <AppButton
                        label={busy ? "Retrying…" : "Retry transmission"}
                        icon="refresh-cw"
                        onPress={handleSubmit}
                        loading={busy}
                        disabled={busy}
                        testID="button-retry-transmission"
                      />
                      <AppButton
                        label="Fix invoice details"
                        icon="edit-3"
                        variant="secondary"
                        onPress={goToFix}
                        disabled={busy}
                        testID="button-fix-invoice"
                      />
                    </>
                  ) : (
                    <>
                      <AppButton
                        label="Fix invoice details"
                        icon="edit-3"
                        onPress={goToFix}
                        disabled={busy}
                        testID="button-fix-invoice"
                      />
                      <AppButton
                        label={busy ? "Retrying…" : "Retry anyway"}
                        icon="refresh-cw"
                        variant="secondary"
                        onPress={handleSubmit}
                        loading={busy}
                        disabled={busy}
                        testID="button-retry-transmission"
                      />
                      <AppText
                        variant="caption"
                        color={colors.mutedForeground}
                        style={{ textAlign: "center" }}
                      >
                        This error needs the invoice fixed first — a plain
                        retry will fail again.
                      </AppText>
                    </>
                  )}
                </View>
              </Card>
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

            <View style={{ gap: 8 }}>
              <AppText variant="heading">Line items</AppText>
              <Card style={{ gap: 8 }}>
                {lines.map((l, i) => (
                  <View key={l.id}>
                    {i > 0 ? <Divider /> : null}
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <AppText variant="label">{l.description}</AppText>
                        <AppText
                          variant="caption"
                          color={colors.mutedForeground}
                        >
                          {l.quantity} × {formatCurrency(l.unitPrice)} · VAT{" "}
                          {(Number(l.vatRate) * 100).toFixed(1)}%
                        </AppText>
                      </View>
                      <AppText variant="label">
                        {formatCurrency(
                          Number(l.lineExtension) + Number(l.vatAmount),
                        )}
                      </AppText>
                    </View>
                  </View>
                ))}
                <Divider />
                <View style={styles.rowBetween}>
                  <AppText variant="heading">Total</AppText>
                  <AppText variant="heading">
                    {formatCurrency(invoice.grandTotal)}
                  </AppText>
                </View>
              </Card>
            </View>

            <View style={{ gap: 8 }}>
              <AppText variant="heading">Transmission history</AppText>
              {attemptsQuery.isLoading ? (
                <CardSkeleton lines={2} />
              ) : attempts.length === 0 ? (
                <Card>
                  <AppText variant="body" color={colors.mutedForeground}>
                    No transmission attempts yet. Submit the invoice to send it
                    to the rail.
                  </AppText>
                </Card>
              ) : (
                <Card padded={false}>
                  {attempts.map((a, i) => {
                    const meta =
                      ATTEMPT_ICON[a.status] ?? ATTEMPT_ICON.pending;
                    const iconColor =
                      meta.toneKey === "success"
                        ? colors.primary
                        : meta.toneKey === "critical"
                          ? colors.destructiveText
                          : colors.mutedForeground;
                    return (
                      <View key={a.id}>
                        {i > 0 ? <Divider /> : null}
                        <View style={styles.attemptRow}>
                          <Feather
                            name={meta.icon}
                            size={18}
                            color={iconColor}
                          />
                          <View style={{ flex: 1 }}>
                            <AppText variant="label">
                              Attempt {a.attemptNo} · {humanize(a.status)}
                            </AppText>
                            <AppText
                              variant="caption"
                              color={colors.mutedForeground}
                            >
                              {humanize(a.rail)} · {timeAgo(a.createdAt)}
                            </AppText>
                            {attemptFailed(a) && a.errorCode ? (
                              <AppText
                                variant="caption"
                                color={colors.destructiveText}
                                style={{ marginTop: 2 }}
                              >
                                Error code: {a.errorCode}
                              </AppText>
                            ) : null}
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </Card>
              )}
            </View>

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
      </ScrollView>
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
  bannerRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  attemptRow: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    alignItems: "flex-start",
  },
});
