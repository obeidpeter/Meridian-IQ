import {
  getGetActionDecisionsQueryKey,
  getGetActionPoliciesQueryKey,
  getGetActionProposalsQueryKey,
  getGetClientAutomationEvidenceQueryKey,
  useGetActionDecisions,
  useGetActionPolicies,
  useGetActionProposals,
  useGetClientAutomationEvidence,
} from "@workspace/api-client-react";
import { useCallback } from "react";

/**
 * The Automation screen's four reads — proposals, standing approvals, the
 * run record and the client's own automation evidence — keyed by the
 * selected client, plus the pull-to-refresh refetch and the combined
 * loading/refetching flags the shell renders from.
 */
export function useAutomationQueries(clientPartyId: string | null) {
  const queryOpts = {
    enabled: !!clientPartyId,
    staleTime: 60_000,
    retry: false,
  };
  const proposalsQuery = useGetActionProposals(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionProposalsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );
  const policiesQuery = useGetActionPolicies(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionPoliciesQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );
  const decisionsQuery = useGetActionDecisions(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        queryKey: getGetActionDecisionsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );
  // Automation evidence (Prove with Clerk phase 2): the client's OWN
  // backtest, fetched at screen level so the grant confirm opens with it.
  // Advisory only — no evidence means the Alert reads exactly as before,
  // and the evidence never gates granting.
  const evidenceQuery = useGetClientAutomationEvidence(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        ...queryOpts,
        staleTime: 5 * 60_000,
        queryKey: getGetClientAutomationEvidenceQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );

  const refetchAll = useCallback(() => {
    void proposalsQuery.refetch();
    void policiesQuery.refetch();
    void decisionsQuery.refetch();
  }, [proposalsQuery, policiesQuery, decisionsQuery]);

  const isLoading =
    proposalsQuery.isLoading ||
    policiesQuery.isLoading ||
    decisionsQuery.isLoading;
  const isRefetching =
    proposalsQuery.isRefetching ||
    policiesQuery.isRefetching ||
    decisionsQuery.isRefetching;

  return {
    proposalsQuery,
    policiesQuery,
    decisionsQuery,
    evidenceQuery,
    refetchAll,
    isLoading,
    isRefetching,
  };
}
