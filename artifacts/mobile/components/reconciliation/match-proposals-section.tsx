import type {
  BankStatement,
  MatchProposalView,
} from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { PENDING_POLL_STALLED_MESSAGE } from "@/lib/pending-poll";

import { MatchProposalCard } from "./match-proposal-card";

/** "Match proposals" for the selected statement, with its polling states. */
export function MatchProposalsSection({
  selectedStatement,
  proposalsQuery,
  canDecide,
  decidingId,
  acceptPending,
  rejectPending,
  stalled,
  onDecide,
}: {
  selectedStatement: BankStatement;
  proposalsQuery: {
    isLoading: boolean;
    isError: boolean;
    data: MatchProposalView[] | undefined;
    refetch: () => Promise<unknown>;
  };
  canDecide: boolean;
  decidingId: string | null;
  acceptPending: boolean;
  rejectPending: boolean;
  /** The bounded proposals poll gave up — the quiet "still processing" line. */
  stalled: boolean;
  onDecide: (
    proposal: MatchProposalView,
    action: "accept" | "reject",
  ) => Promise<void>;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="heading">Match proposals</AppText>
      <AppText variant="caption" color={colors.mutedForeground}>
        Accepting a match records the payment against the invoice and marks it
        settled. Rejecting keeps the invoice outstanding.
      </AppText>
      {proposalsQuery.isLoading ? (
        <CardSkeleton lines={3} />
      ) : proposalsQuery.isError ? (
        <ErrorState
          message="We couldn't load the match proposals."
          onRetry={() => void proposalsQuery.refetch()}
        />
      ) : (proposalsQuery.data ?? []).length === 0 ? (
        selectedStatement.status === "committed" ? (
          <EmptyState
            icon="loader"
            title="Matching in progress…"
            message="The statement is committed; proposals appear here as soon as matching finishes (a few seconds)."
          />
        ) : (
          <EmptyState
            icon="search"
            title="No matches found"
            message="None of this statement's credits matched an open invoice."
          />
        )
      ) : (
        (proposalsQuery.data ?? []).map((p) => (
          <MatchProposalCard
            key={p.id}
            proposal={p}
            deciding={decidingId === p.id}
            canDecide={canDecide}
            acceptPending={acceptPending}
            rejectPending={rejectPending}
            onDecide={onDecide}
          />
        ))
      )}
      {stalled ? (
        <AppText variant="caption" color={colors.mutedForeground}>
          {PENDING_POLL_STALLED_MESSAGE}
        </AppText>
      ) : null}
    </View>
  );
}
