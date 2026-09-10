import {
  getGetVatPackQueryKey,
  getGetRejectionPatternsQueryKey,
  useGetVatPack,
  useGetRejectionPatterns,
  useGetFirmComplianceCalendar,
  getGetFirmComplianceCalendarQueryKey,
  useGetVatSettlementCheck,
  getGetVatSettlementCheckQueryKey,
  useGetFirmVatPositions,
  getGetFirmVatPositionsQueryKey,
  useGetQuarterlyReview,
  getGetQuarterlyReviewQueryKey,
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
  useListStatementConnections,
  getListStatementConnectionsQueryKey,
} from "@workspace/api-client-react";
import { isFirmAdminRole } from "@/components/governance-card";
import { isFirmMemberRole } from "@/components/staff-notification-prefs-card";
import { calendarHasContent, rejectionsHaveContent } from "./helpers";

// Section occupancy: observe the SAME queries the section's self-gating
// cards gate on — identical query keys, so react-query dedupes each to a
// single fetch shared with the card once it mounts. Enabled only once the
// book has clients, mirroring when the sections themselves can render.
export function usePortfolioOccupancy({
  hasBook,
  role,
}: {
  hasBook: boolean;
  role: string | null | undefined;
}) {
  const gateVatPack = useGetVatPack(undefined, {
    query: {
      queryKey: getGetVatPackQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateSettlement = useGetVatSettlementCheck(undefined, {
    query: {
      queryKey: getGetVatSettlementCheckQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateVatPositions = useGetFirmVatPositions(undefined, {
    query: {
      queryKey: getGetFirmVatPositionsQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateQuarterly = useGetQuarterlyReview(undefined, {
    query: {
      queryKey: getGetQuarterlyReviewQueryKey(undefined),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateCalendar = useGetFirmComplianceCalendar({
    query: {
      queryKey: getGetFirmComplianceCalendarQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateRejections = useGetRejectionPatterns({
    query: {
      queryKey: getGetRejectionPatternsQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateConnections = useListStatementConnections({
    query: {
      queryKey: getListStatementConnectionsQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const gateDigest = useGetClerkDigest({
    query: {
      queryKey: getGetClerkDigestQueryKey(),
      retry: false,
      enabled: hasBook,
    },
  });
  const complianceOccupied =
    (gateCalendar.isSuccess && calendarHasContent(gateCalendar.data)) ||
    gateVatPack.isSuccess ||
    gateSettlement.isSuccess ||
    gateVatPositions.isSuccess ||
    gateQuarterly.isSuccess ||
    (gateRejections.isSuccess && rejectionsHaveContent(gateRejections.data)) ||
    // The governance card renders for firm admins (including its inline
    // error state), and only for them — mirror its role self-gate.
    isFirmAdminRole(role);
  const connectionsOccupied =
    gateConnections.isSuccess ||
    gateDigest.isSuccess ||
    // The staff-prefs card renders for firm members (including its inline
    // error state), and only for them — mirror its role gate.
    isFirmMemberRole(role);

  return { complianceOccupied, connectionsOccupied };
}
