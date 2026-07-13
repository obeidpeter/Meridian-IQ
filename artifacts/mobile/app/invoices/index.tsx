import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getListInvoicesQueryKey,
  useBulkSubmitInvoices,
  useListInvoices,
  useListParties,
} from "@workspace/api-client-react";
import type {
  BulkSubmitRowResult,
  Invoice,
  ListInvoicesParams,
} from "@workspace/api-client-react";
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { formatCurrency, formatDate, humanize } from "@/lib/format";
import { INVOICE_STATUS_TONE } from "@/lib/invoice-status";
import { useSession } from "@/lib/session";

// Server page size. Passing limit/offset switches GET /invoices into its
// newest-first bounded mode, so we never pull the unbounded legacy list.
const PAGE_SIZE = 50;

// How many needs-attention rows to render in the bulk report — a batch can
// flag up to 200 drafts and the report is a decision aid, not a ledger.
const MAX_BULK_ROWS = 20;

/** The first issue on a bulk row, for the one-line summary under the number. */
function bulkRowIssue(row: BulkSubmitRowResult): string {
  const first = row.errors[0];
  if (first) return `${first.field}: ${first.message}`;
  return row.error || "Submission failed — open the invoice for details.";
}

const BULK_CONFIRM_TITLE = "Submit all pending drafts?";
const BULK_CONFIRM_MESSAGE =
  "This validates every pending draft (oldest first) and submits the valid " +
  "ones to the FIRS stamping rail, in batches of up to 200. Submission " +
  "cannot be undone. Drafts that fail validation stay pending, with their " +
  "issues listed so you can fix them.";

export default function InvoiceListScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { clientPartyId } = useSession();

  const parties = useListParties();

  // Debounced server-side search plus paging cursor, kept in one state object
  // so a new search term resets to the first page in the same update.
  const [search, setSearch] = useState("");
  const [paging, setPaging] = useState<{ q: string; offset: number }>({
    q: "",
    offset: 0,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      const q = search.trim();
      setPaging((prev) => (prev.q === q ? prev : { q, offset: 0 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params: ListInvoicesParams = paging.q
    ? { limit: PAGE_SIZE, offset: paging.offset, q: paging.q }
    : { limit: PAGE_SIZE, offset: paging.offset };
  const listQuery = useListInvoices(params, {
    query: { queryKey: getListInvoicesQueryKey(params) },
  });
  const page = listQuery.data;

  // Earlier pages accumulated per search term, keyed by offset so a background
  // refetch of a page replaces it instead of appending a duplicate. The
  // current offset's page always comes live from the query and is merged in
  // below; the effect just persists it for later offsets.
  const [pages, setPages] = useState<{
    q: string;
    byOffset: Record<number, Invoice[]>;
  }>({ q: "", byOffset: {} });

  useEffect(() => {
    if (!page) return;
    setPages((prev) =>
      prev.q === paging.q
        ? { q: prev.q, byOffset: { ...prev.byOffset, [paging.offset]: page } }
        : { q: paging.q, byOffset: { [paging.offset]: page } },
    );
  }, [page, paging]);

  const byOffset = useMemo(() => {
    const merged: Record<number, Invoice[]> =
      pages.q === paging.q ? { ...pages.byOffset } : {};
    if (page) merged[paging.offset] = page;
    return merged;
  }, [pages, paging, page]);

  // Flatten the pages in offset order, deduped by id (an invoice can slide
  // across a page boundary between fetches when newer ones are created).
  const loaded = useMemo(() => {
    const seen = new Map<string, Invoice>();
    const offsets = Object.keys(byOffset)
      .map(Number)
      .sort((a, b) => a - b);
    for (const offset of offsets) {
      for (const inv of byOffset[offset] ?? []) {
        if (!seen.has(inv.id)) seen.set(inv.id, inv);
      }
    }
    return [...seen.values()];
  }, [byOffset]);

  // The client's own invoice book — firm principals may receive other
  // clients' invoices in the same list, so scope to the selected client.
  const rows = useMemo(
    () =>
      loaded.filter(
        (inv) => !clientPartyId || inv.supplierPartyId === clientPartyId,
      ),
    [loaded, clientPartyId],
  );

  const hasLoaded = Object.keys(byOffset).length > 0;
  const lastPage = byOffset[paging.offset];
  const hasMore = !!lastPage && lastPage.length === PAGE_SIZE;
  const loadingMore = listQuery.isFetching && hasLoaded && !lastPage;
  const initialLoading = listQuery.isLoading && !hasLoaded;

  const partyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of parties.data ?? []) map.set(p.id, p.legalName);
    return map;
  }, [parties.data]);

  const loadMore = useCallback(() => {
    setPaging((prev) => ({ ...prev, offset: prev.offset + PAGE_SIZE }));
  }, []);

  const onEndReached = useCallback(() => {
    if (hasMore && !loadingMore && !listQuery.isFetching) loadMore();
  }, [hasMore, loadingMore, listQuery.isFetching, loadMore]);

  // Pull-to-refresh: drop the accumulated pages, jump back to the first page
  // and refetch it. The prefix key marks every param variant stale.
  const onRefresh = useCallback(() => {
    setPages((prev) => ({ q: prev.q, byOffset: {} }));
    setPaging((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
    void queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
  }, [queryClient]);

  // Bulk submit: `bulkReport === null` means no run yet; a report renders the
  // results card. Rows accumulate across batches, deduped by invoiceId (an
  // invalid draft stays pending by design, so it reappears in every batch
  // until fixed).
  const bulkSubmit = useBulkSubmitInvoices();
  const [bulkReport, setBulkReport] = useState<{
    rows: BulkSubmitRowResult[];
    remaining: number;
  } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const runBulkSubmit = useCallback(async () => {
    if (!clientPartyId) return;
    setBulkError(null);
    try {
      const res = await bulkSubmit.mutateAsync({ data: { clientPartyId } });
      setBulkReport((prev) => {
        const byId = new Map(
          (prev?.rows ?? []).map((r) => [r.invoiceId, r] as const),
        );
        for (const r of res.rows) byId.set(r.invoiceId, r);
        return { rows: [...byId.values()], remaining: res.remaining };
      });
      // Not awaited: a background refetch rejection must not surface as a
      // false "bulk submit failed" error after the batch already ran. The
      // no-args list key prefix-matches every param variant.
      void queryClient.invalidateQueries({
        queryKey: getListInvoicesQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey({ clientPartyId }),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetReceivablesSummaryQueryKey({ clientPartyId }),
      });
      // Drop the accumulated pages and jump back to the first page so the
      // refreshed statuses show instead of stale later pages.
      setPages((prev) => ({ q: prev.q, byOffset: {} }));
      setPaging((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
    } catch (error) {
      setBulkError(
        apiErrorMessage(
          error,
          "We couldn't submit your drafts. Please try again.",
        ),
      );
    }
  }, [clientPartyId, bulkSubmit, queryClient]);

  const confirmBulkSubmit = useCallback(() => {
    // Alert.alert is a no-op on react-native-web, so fall back to the
    // browser's native confirm there (same pattern as settings' sign-out).
    if (Platform.OS === "web") {
      if (window.confirm(`${BULK_CONFIRM_TITLE}\n\n${BULK_CONFIRM_MESSAGE}`)) {
        void runBulkSubmit();
      }
      return;
    }
    Alert.alert(BULK_CONFIRM_TITLE, BULK_CONFIRM_MESSAGE, [
      { text: "Cancel", style: "cancel" },
      { text: "Validate & submit", onPress: () => void runBulkSubmit() },
    ]);
  }, [runBulkSubmit]);

  const bulkRows = bulkReport?.rows ?? [];
  const bulkSubmitted = bulkRows.filter(
    (r) => r.outcome === "submitted",
  ).length;
  const bulkNeedsAttention = bulkRows.filter((r) => r.outcome !== "submitted");

  const openInvoice = useCallback(
    (id: string) => {
      router.push(`/invoices/${id}`);
    },
    [router],
  );

  const listHeader = (
    <View style={{ gap: 12, marginBottom: 12 }}>
      {bulkError ? <Banner tone="error" message={bulkError} /> : null}

      {bulkReport ? (
        <Card style={{ gap: 10 }}>
          <View style={styles.rowBetween}>
            <AppText variant="heading" style={{ flex: 1, paddingRight: 8 }}>
              {bulkRows.length === 0
                ? "No pending drafts"
                : `Submitted ${bulkSubmitted} of ${bulkRows.length}`}
            </AppText>
            <Pressable
              onPress={() => setBulkReport(null)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss bulk submit results"
              hitSlop={12}
              testID="button-dismiss-bulk-report"
            >
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
          <AppText variant="caption" color={colors.mutedForeground}>
            {bulkRows.length === 0
              ? "There was nothing to validate — every invoice is already past the draft stage."
              : bulkNeedsAttention.length === 0
                ? "Every pending draft in this run is now on the stamping rail."
                : `${bulkNeedsAttention.length} draft(s) need a fix before they can be submitted.`}
          </AppText>
          {bulkNeedsAttention.length > 0 ? (
            <View style={{ gap: 8 }}>
              <AppText variant="label">Needs attention</AppText>
              {bulkNeedsAttention.slice(0, MAX_BULK_ROWS).map((r, index) => (
                <View key={r.invoiceId}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    onPress={() => openInvoice(r.invoiceId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Invoice ${r.invoiceNumber}, ${
                      r.outcome === "invalid" ? "invalid" : "failed"
                    }: ${bulkRowIssue(r)}`}
                    accessibilityHint="Opens invoice details"
                    style={({ pressed }) => [
                      styles.bulkRow,
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                    testID={`bulk-row-${r.invoiceId}`}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={styles.inlineRow}>
                        <AppText
                          variant="label"
                          numberOfLines={1}
                          style={{ flexShrink: 1 }}
                        >
                          {r.invoiceNumber}
                        </AppText>
                        <Badge
                          label={r.outcome === "invalid" ? "Invalid" : "Failed"}
                          tone={r.outcome === "invalid" ? "warning" : "critical"}
                        />
                      </View>
                      <AppText
                        variant="caption"
                        color={colors.destructiveText}
                        numberOfLines={2}
                        style={{ marginTop: 2 }}
                      >
                        {bulkRowIssue(r)}
                      </AppText>
                    </View>
                    <Feather
                      name="chevron-right"
                      size={16}
                      color={colors.mutedForeground}
                    />
                  </Pressable>
                </View>
              ))}
              {bulkNeedsAttention.length > MAX_BULK_ROWS ? (
                <AppText variant="caption" color={colors.mutedForeground}>
                  …and {bulkNeedsAttention.length - MAX_BULK_ROWS} more
                  draft(s).
                </AppText>
              ) : null}
            </View>
          ) : null}
          {bulkReport.remaining > 0 ? (
            <>
              <AppText variant="caption" color={colors.mutedForeground}>
                {bulkReport.remaining} more pending draft
                {bulkReport.remaining === 1 ? "" : "s"} — invalid drafts stay
                pending until fixed, so they count toward this total.
              </AppText>
              <AppButton
                label={
                  bulkSubmit.isPending ? "Submitting…" : "Submit next batch"
                }
                icon="send"
                onPress={() => void runBulkSubmit()}
                loading={bulkSubmit.isPending}
                disabled={bulkSubmit.isPending}
                testID="button-bulk-next-batch"
              />
            </>
          ) : null}
        </Card>
      ) : null}

      {clientPartyId ? (
        <AppButton
          label={bulkSubmit.isPending ? "Submitting…" : "Submit all drafts"}
          icon="send"
          variant="secondary"
          onPress={confirmBulkSubmit}
          loading={bulkSubmit.isPending}
          disabled={initialLoading || bulkSubmit.isPending}
          testID="button-bulk-submit"
        />
      ) : null}
    </View>
  );

  const listEmpty = initialLoading ? (
    <View style={{ gap: 12 }}>
      <CardSkeleton lines={2} />
      <CardSkeleton lines={2} />
      <CardSkeleton lines={2} />
    </View>
  ) : listQuery.isError ? (
    <ErrorState
      message="We couldn't load your invoices."
      onRetry={() => void listQuery.refetch()}
    />
  ) : paging.q ? (
    <EmptyState
      icon="search"
      title="No matches"
      message="No invoices match your search."
    />
  ) : (
    <EmptyState
      icon="file-text"
      title="No invoices yet"
      message="Create your first invoice from the New Invoice tab."
    />
  );

  const listFooter =
    hasLoaded && rows.length > 0 ? (
      <View style={styles.footer}>
        <AppText variant="caption" color={colors.mutedForeground}>
          Showing {rows.length} invoice{rows.length === 1 ? "" : "s"}
        </AppText>
        {listQuery.isError ? (
          <>
            <AppText variant="caption" color={colors.destructiveText}>
              Unable to load more invoices.
            </AppText>
            <AppButton
              label="Try again"
              icon="refresh-cw"
              variant="secondary"
              fullWidth={false}
              onPress={() => void listQuery.refetch()}
            />
          </>
        ) : loadingMore ? (
          <ActivityIndicator color={colors.primary} />
        ) : hasMore ? (
          <AppButton
            label="Load more"
            icon="chevron-down"
            variant="secondary"
            fullWidth={false}
            onPress={loadMore}
            testID="button-load-more"
          />
        ) : null}
      </View>
    ) : null;

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Invoices")} />
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* The search field lives outside the list so it never remounts (and
            never drops the keyboard) while pages stream in. */}
        <View style={styles.searchWrap}>
          <TextField
            label="Search invoices"
            value={search}
            onChangeText={setSearch}
            placeholder="Invoice number or customer name"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={120}
            returnKeyType="search"
            testID="input-invoice-search"
          />
        </View>
        {/* FlatList virtualizes the rows so a large book isn't all mounted at
            once; reaching the end appends the next server page. */}
        <FlatList
          style={{ backgroundColor: colors.background }}
          data={rows}
          keyExtractor={(inv) => inv.id}
          renderItem={({ item }) => (
            <InvoiceRow
              invoice={item}
              buyerName={partyName.get(item.buyerPartyId)}
              onPress={() => openInvoice(item.id)}
            />
          )}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 48 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={listQuery.isRefetching}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        />
      </View>
    </>
  );
}

function InvoiceRow({
  invoice,
  buyerName,
  onPress,
}: {
  invoice: Invoice;
  buyerName: string | undefined;
  onPress: () => void;
}) {
  const colors = useColors();
  const a11yLabel = [
    `Invoice ${invoice.invoiceNumber}`,
    buyerName,
    humanize(invoice.status),
    formatCurrency(invoice.grandTotal),
    `Issued ${formatDate(invoice.issueDate)}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint="Opens invoice details"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      testID={`invoice-item-${invoice.id}`}
    >
      <Card>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <View style={styles.inlineRow}>
              <AppText
                variant="label"
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {invoice.invoiceNumber}
              </AppText>
              <Badge
                label={humanize(invoice.status)}
                tone={INVOICE_STATUS_TONE[invoice.status] ?? "neutral"}
              />
            </View>
            <AppText
              variant="caption"
              color={colors.mutedForeground}
              numberOfLines={1}
              style={{ marginTop: 4 }}
            >
              {buyerName || "Unknown customer"} · Issued{" "}
              {formatDate(invoice.issueDate)}
            </AppText>
          </View>
          <View style={styles.inlineRow}>
            <AppText variant="label">
              {formatCurrency(invoice.grandTotal)}
            </AppText>
            <Feather
              name="chevron-right"
              size={16}
              color={colors.mutedForeground}
            />
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 4,
    ...webContentMax,
  },
  searchWrap: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    ...webContentMax,
  },
  rowBetween: { ...rowBetween },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bulkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  footer: {
    marginTop: 16,
    alignItems: "center",
    gap: 10,
  },
});
