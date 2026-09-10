import { useRoute, useLocation } from "wouter";
import {
  useGetMe,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStatusLightQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  operationSessionKey,
  usePinnedItems,
  useRecordRecentItem,
} from "@workspace/web-ui";
import { statusLabel } from "@/lib/format";
import {
  useFailureCatalogue,
  useInvoiceHistory,
  useInvoiceRecord,
} from "./use-invoice-queries";
import { useAdjustFlow, useSubmitFlow } from "./use-invoice-actions";

// Everything the invoice detail page holds and does (R126 moved it out of
// the page shell): the route id, the record and history queries, the
// failure catalogue, the principal's pins and recents, and the submit and
// adjust flows with their mutations, state and handlers. The shell calls it
// once and hands the bag to the sections, so nothing about closures changed
// in the split and no query, poll or storage hook runs twice; the shell
// keeps the loading and error returns and computes the abilities after
// them.
export function useInvoiceDetail() {
  const [, params] = useRoute("/invoices/:id");
  const id = params?.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const record = useInvoiceRecord(id);
  const { data, invoice, tone, stampedFamily, refetch } = record;
  const history = useInvoiceHistory(id, invoice, stampedFamily);
  const catalogue = useFailureCatalogue(history.attempts, tone);
  const { errorCode } = catalogue;

  const { data: me } = useGetMe();
  const pinnedInvoices = usePinnedItems(
    me ? `meridianiq:pinned-invoices:${me.userId}` : null,
  );
  const operationKey = operationSessionKey(me);

  // Recognition over recall: the command menu offers the last few invoices
  // this user opened; record this one once it resolves.
  useRecordRecentItem(
    me ? `meridianiq:recent-invoices:${me.userId}` : null,
    invoice
      ? {
          id,
          label: invoice.invoiceNumber,
          detail: statusLabel(invoice.status),
        }
      : null,
  );

  // The invoice and its attempt history refresh together after anything that
  // may have moved the lifecycle. Deliberately NOT awaited at any call site:
  // a background refetch rejection must not mask the toast the handler is
  // about to show, nor turn an already-landed mutation into a false failure.
  const refreshInvoiceState = () => {
    queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
    queryClient.invalidateQueries({
      queryKey: getListSubmissionAttemptsQueryKey(id),
    });
    // The status-light card narrates the same lifecycle ("has not been
    // submitted yet") — left stale it flatly contradicts the badge the
    // instant after submitting (2026-08 cognitive walkthrough, step A9).
    queryClient.invalidateQueries({
      queryKey: getGetInvoiceStatusLightQueryKey(id),
    });
  };

  const submitFlow = useSubmitFlow({
    id,
    data,
    invoice,
    tone,
    me,
    toast,
    refetch,
    refreshInvoiceState,
    operationKey,
  });
  const adjustFlow = useAdjustFlow({
    id,
    data,
    invoice,
    me,
    errorCode,
    toast,
    queryClient,
    refreshInvoiceState,
    navigate,
  });

  return {
    ...record,
    ...history,
    ...catalogue,
    ...submitFlow,
    ...adjustFlow,
    id,
    navigate,
    me,
    pinnedInvoices,
    operationKey,
    queryClient,
    toast,
  };
}

export type InvoiceDetailState = ReturnType<typeof useInvoiceDetail>;
