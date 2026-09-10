import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetClientPortfolio,
  useGetMe,
  useExportClientData,
  getExportClientDataQueryKey,
  useOffboardClient,
  getGetPortfolioQueryKey,
  useListWhtCredits,
  useGetWhtRemittance,
  getListWhtCreditsQueryKey,
  getGetWhtRemittanceQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { whtCardHasContent } from "@/components/wht-card";
import { downloadBlob } from "@/lib/download";
import { serverErrorMessage } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
  useRecordRecentItem,
  usePinnedItems,
  useUrlTab,
} from "@workspace/web-ui";
import {
  CLIENT_VIEWS,
  type ClientView,
  exportFilename,
  offboardErrorNote,
  offboardSummary,
  visibleClientViews,
} from "./helpers";

// Everything the client page holds and does (R126 moved it out of the page
// shell): the portfolio query, pins and recents, the data-subject export, the
// offboard flow and the view gating. The shell calls it once and hands the
// bag to the header actions, the view panels and the offboard dialog, so
// nothing about hook order or closures changed in the split; the shell keeps
// the loading and error returns.
export function useClientDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data, isLoading, error, refetch } = useGetClientPortfolio(id);
  usePageTitle(data?.client.legalName ?? "Client detail");

  const { data: me } = useGetMe();
  const operationKey = operationSessionKey(me);
  const pinnedClients = usePinnedItems(
    me ? `meridianiq:pinned-clients:${me.userId}` : null,
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  // Recognition over recall: the command menu offers the last few clients
  // this user opened; record this one once it resolves.
  useRecordRecentItem(
    me ? `meridianiq:recent-clients:${me.userId}` : null,
    data ? { id, label: data.client.legalName } : null,
  );

  // Data-subject export: the query sits armed but idle; the button fetches
  // once and saves the server's bundle verbatim.
  const exportQuery = useExportClientData(id, {
    query: {
      queryKey: getExportClientDataQueryKey(id),
      enabled: false,
      retry: false,
    },
  });
  const handleExport = async () => {
    const operation = beginOperation(operationKey, {
      title: data ? `Export ${data.client.legalName}` : "Export client data",
      kind: "export",
      route: `/clients/${id}`,
    });
    const res = await exportQuery.refetch();
    if (res.error || !res.data) {
      updateOperation(operationKey, operation?.id, {
        status: "failed",
        detail: "The export bundle could not be prepared.",
        savedSummary: "No file was saved.",
      });
      toast({
        title: "Could not export the client's data",
        description: serverErrorMessage(res.error),
        variant: "destructive",
      });
      return;
    }
    downloadBlob(
      exportFilename(id),
      JSON.stringify(res.data, null, 2),
      "application/json",
    );
    updateOperation(operationKey, operation?.id, {
      status: "succeeded",
      detail: "The client data bundle was prepared successfully.",
      savedSummary: `${exportFilename(id)} was saved to this device.`,
    });
  };

  // Offboarding (firm_admin only): typed-name confirm, server-verified.
  const offboard = useOffboardClient();
  const [offboardOpen, setOffboardOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [offboardNote, setOffboardNote] = useState<string | null>(null);
  const [view, setView] = useUrlTab<ClientView>("view", "today", CLIENT_VIEWS);

  // ---- View gating + Money-view occupancy (portfolio's section-occupancy
  // pattern): tabs follow Me.features exactly like the nav, and because the
  // WHT card self-gates to null on an empty ledger, the Money view observes
  // the SAME queries the card gates on (identical keys — react-query
  // dedupes) to know when to show an EmptyState instead of a bare grid.
  const features = new Set(me?.features ?? []);
  const visibleViews = visibleClientViews(features);
  const activeView: ClientView = visibleViews.includes(view) ? view : "today";
  const whtParams = { clientPartyId: id };
  const whtGate = useListWhtCredits(whtParams, {
    query: {
      enabled: !!id && features.has("statutory_desks"),
      queryKey: getListWhtCreditsQueryKey(whtParams),
      staleTime: 60_000,
      retry: false,
    },
  });
  const whtRemitGate = useGetWhtRemittance(whtParams, {
    query: {
      enabled: !!id && features.has("statutory_desks"),
      queryKey: getGetWhtRemittanceQueryKey(whtParams),
      staleTime: 60_000,
      retry: false,
    },
  });
  const moneyEmpty =
    !features.has("collection_accounts") &&
    (whtGate.isSuccess || whtGate.isError) &&
    !whtCardHasContent(
      whtGate.data,
      whtRemitGate.isSuccess ? whtRemitGate.data : undefined,
    );

  const openOffboard = () => {
    setConfirmText("");
    setOffboardNote(null);
    setOffboardOpen(true);
  };

  const handleOffboard = () => {
    setOffboardNote(null);
    offboard.mutate(
      { id, data: { confirmLegalName: confirmText.trim() } },
      {
        onSuccess: (result) => {
          toast({
            title: "Client offboarded",
            description: offboardSummary(result),
          });
          // The book changed — refresh the portfolio the navigation lands on.
          void queryClient.invalidateQueries({
            queryKey: getGetPortfolioQueryKey(),
          });
          navigate("/portfolio");
        },
        onError: (err) => setOffboardNote(offboardErrorNote(err)),
      },
    );
  };

  return {
    id,
    data,
    isLoading,
    error,
    refetch,
    me,
    pinnedClients,
    exportQuery,
    handleExport,
    offboard,
    offboardOpen,
    setOffboardOpen,
    confirmText,
    setConfirmText,
    offboardNote,
    features,
    visibleViews,
    activeView,
    setView,
    moneyEmpty,
    openOffboard,
    handleOffboard,
  };
}

export type ClientDetailState = ReturnType<typeof useClientDetail>;
