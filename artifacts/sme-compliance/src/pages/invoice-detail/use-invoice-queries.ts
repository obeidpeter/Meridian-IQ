// The invoice detail page's reads (R126 moved them out of the page shell):
// the invoice record itself, the history and status queries around it, and
// the failure catalogue lookup. Three hooks, not one, so each stays under
// the ratchet without folding the repeated polling expressions together.
// Only use-invoice-detail.ts calls them.
import {
  useGetInvoice,
  useGetParty,
  getGetPartyQueryKey,
  useListSubmissionAttempts,
  useGetInvoiceStamp,
  useListEscalations,
  useGetErrorCatalogueEntry,
  useListConfirmations,
  useListSettlements,
  useGetInvoiceStatusLight,
  useGetInvoiceRejectionRisk,
  getGetInvoiceRejectionRiskQueryKey,
  getGetInvoiceQueryKey,
  getListSubmissionAttemptsQueryKey,
  getGetInvoiceStampQueryKey,
  getListEscalationsQueryKey,
  getGetErrorCatalogueEntryQueryKey,
  getListConfirmationsQueryKey,
  getListSettlementsQueryKey,
  getGetInvoiceStatusLightQueryKey,
  useListInvoiceApprovals,
  getListInvoiceApprovalsQueryKey,
  type Invoice,
  type SubmissionAttempt,
} from "@workspace/api-client-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { statusTone } from "@/lib/format";

export function useInvoiceRecord(id: string) {
  const { data, isLoading, isError, error, refetch } = useGetInvoice(id, {
    query: {
      enabled: !!id,
      queryKey: getGetInvoiceQueryKey(id),
      // A submitted invoice resolves rail-side (stamped or failed) with no
      // user action — poll while pending so the page advances on its own
      // instead of freezing on "Pending stamp" until a manual reload.
      refetchInterval: (query) =>
        query.state.data?.invoice.status === "submitted" ? 15_000 : false,
    },
  });
  const invoice = data?.invoice;
  const { data: buyer } = useGetParty(invoice?.buyerPartyId ?? "", {
    query: {
      enabled: !!invoice?.buyerPartyId,
      queryKey: getGetPartyQueryKey(invoice?.buyerPartyId ?? ""),
      retry: false,
    },
  });
  usePageTitle(invoice ? invoice.invoiceNumber : "Invoice");
  const tone = invoice ? statusTone(invoice.status) : "draft";
  // Settled/credited invoices were stamped first, so keep their stamp visible.
  const stampedFamily =
    tone === "stamped" || tone === "settled" || tone === "credited";

  return {
    data,
    invoice,
    isLoading,
    isError,
    error,
    refetch,
    buyer,
    tone,
    stampedFamily,
  };
}

export function useInvoiceHistory(
  id: string,
  invoice: Invoice | undefined,
  stampedFamily: boolean,
) {
  const attemptsQuery = useListSubmissionAttempts(id, {
    query: {
      enabled: !!id,
      queryKey: getListSubmissionAttemptsQueryKey(id),
      // Same rhythm as the invoice itself: the timeline row for the pending
      // attempt resolves with it.
      refetchInterval: invoice?.status === "submitted" ? 15_000 : false,
    },
  });
  const stampQuery = useGetInvoiceStamp(id, {
    query: {
      enabled: !!id && stampedFamily,
      queryKey: getGetInvoiceStampQueryKey(id),
    },
  });
  const escalationsQuery = useListEscalations(id, {
    query: { enabled: !!id, queryKey: getListEscalationsQueryKey(id) },
  });
  const confirmationsQuery = useListConfirmations(id, {
    query: {
      enabled: !!id,
      queryKey: getListConfirmationsQueryKey(id),
      retry: false,
    },
  });
  const settlementsQuery = useListSettlements(id, {
    query: {
      enabled: !!id,
      queryKey: getListSettlementsQueryKey(id),
      retry: false,
    },
  });
  const approvalsQuery = useListInvoiceApprovals(id, {
    query: {
      enabled: !!id,
      queryKey: getListInvoiceApprovalsQueryKey(id),
      retry: false,
    },
  });
  // Progressive enhancement: if the light can't load, the card simply doesn't
  // render — it must never break the rest of the page.
  const { data: statusLight, isLoading: statusLightLoading } =
    useGetInvoiceStatusLight(id, {
      query: {
        enabled: !!id,
        queryKey: getGetInvoiceStatusLightQueryKey(id),
        retry: false,
        staleTime: 30_000,
        // Same rhythm as the invoice itself: when the rail answers, the
        // light's story must advance with the badge, not lag a remount.
        refetchInterval: invoice?.status === "submitted" ? 15_000 : false,
      },
    });
  // Draft-time rejection risk (contract 0.36.0): only fetched while the
  // invoice can still be edited before its first submission — once it is on
  // the rail the attempt history speaks for itself. Same posture as the
  // status light: render on success only, any error means no card.
  const riskEligible =
    invoice?.status === "draft" || invoice?.status === "validated";
  const { data: rejectionRisk } = useGetInvoiceRejectionRisk(id, {
    query: {
      enabled: !!id && riskEligible,
      queryKey: getGetInvoiceRejectionRiskQueryKey(id),
      retry: false,
      staleTime: 30_000,
    },
  });

  return {
    attempts: attemptsQuery.data,
    stamp: stampQuery.data,
    escalations: escalationsQuery.data,
    confirmations: confirmationsQuery.data,
    confirmationsError: confirmationsQuery.error,
    settlements: settlementsQuery.data,
    attemptsQuery,
    stampQuery,
    escalationsQuery,
    confirmationsQuery,
    settlementsQuery,
    approvalsQuery,
    statusLight,
    statusLightLoading,
    riskEligible,
    rejectionRisk,
  };
}

export function useFailureCatalogue(
  attempts: SubmissionAttempt[] | undefined,
  tone: ReturnType<typeof statusTone>,
) {
  // The API lists attempts oldest-first; rows of one try share attemptNo
  // and the terminal answer comes LAST (a failover leaves the first rail's
  // error beside the rejection), so among the highest attemptNo keep the
  // later row.
  const latestFailed = (attempts || [])
    .filter(
      (a) => (a.status === "rejected" || a.status === "error") && a.errorCode,
    )
    .reduce<
      (typeof attempts extends (infer T)[] | undefined ? T : never) | undefined
    >((best, a) => (!best || a.attemptNo >= best.attemptNo ? a : best), undefined);
  const errorCode = latestFailed?.errorCode || undefined;
  const { data: catalogue } = useGetErrorCatalogueEntry(errorCode || "", {
    query: {
      enabled: !!errorCode && tone === "failed",
      queryKey: getGetErrorCatalogueEntryQueryKey(errorCode || ""),
    },
  });

  return { errorCode, catalogue };
}
