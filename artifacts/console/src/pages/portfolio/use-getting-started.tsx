import { useEffect, useState } from "react";
import {
  useListInvitations,
  getListInvitationsQueryKey,
} from "@workspace/api-client-react";
import type { PortfolioSummary } from "@workspace/api-client-react";
import { AddClientDialog } from "@/components/add-client-dialog";
import {
  browserStorage,
  gettingStartedSteps,
  hasClientOwnerInvite,
  portfolioInvoiceCount,
  portfolioSubmittedCount,
  readGettingStartedDismissed,
  shouldShowGettingStarted,
  writeGettingStartedDismissed,
} from "./helpers";

// The getting-started checklist and the single-client intake dialog (R126
// lifted them out of the page shell at the same hook position, so the
// states, the effect and the invitations query keep their order).
export function useGettingStarted({
  data,
  requestedAction,
  setRequestedAction,
}: {
  data: PortfolioSummary | undefined;
  requestedAction: string;
  setRequestedAction: (next: string) => void;
}) {
  // Getting-started checklist state: single-client intake dialog + the
  // localStorage-backed dismissal.
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [gettingStartedDismissed, setGettingStartedDismissed] = useState(() =>
    readGettingStartedDismissed(browserStorage()),
  );
  useEffect(() => {
    if (requestedAction !== "add-client") return;
    setAddClientOpen(true);
    setRequestedAction("");
  }, [requestedAction, setRequestedAction]);
  // Step 2's evidence. Fetched only while the checklist could still show —
  // a dismissed card costs nothing.
  const { data: invitations } = useListInvitations({
    query: {
      queryKey: getListInvitationsQueryKey(),
      retry: false,
      enabled: !gettingStartedDismissed && !!data,
    },
  });
  // Checklist inputs, computed from data already on the page (portfolio
  // counts + the invitations list above).
  const steps = gettingStartedSteps({
    clientCount: data?.clients.length ?? 0,
    hasClientInvite: hasClientOwnerInvite(invitations),
    invoiceCount: portfolioInvoiceCount(data?.clients ?? []),
    submittedCount: portfolioSubmittedCount(data?.clients ?? []),
  });
  const showGettingStarted =
    !!data &&
    shouldShowGettingStarted({
      clientCount: data.clients.length,
      steps,
      dismissed: gettingStartedDismissed,
    });
  const handleDismissGettingStarted = () => {
    writeGettingStartedDismissed(browserStorage());
    setGettingStartedDismissed(true);
  };
  const openAddClient = () => setAddClientOpen(true);
  const addClientDialog = (
    <AddClientDialog open={addClientOpen} onOpenChange={setAddClientOpen} />
  );

  return {
    steps,
    showGettingStarted,
    handleDismissGettingStarted,
    openAddClient,
    addClientDialog,
  };
}
