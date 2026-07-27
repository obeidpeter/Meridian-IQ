import {
  assertClientPartyScope,
  clientPartyScope,
  requireFirmScope,
  type Principal,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";

// SEC-03 resolution shared by the on-demand analytics miners (line-item
// suggestions, payment behaviour, unmatched credits, projection accuracy,
// recurring suggestions, unbilled income): a client_user is pinned to its own
// party; a firm principal names the client. Missing target is a 400; a
// client_user naming a sibling party is refused by assertClientPartyScope.
export function resolveClientAnalyticsScope(
  principal: Principal,
  requestedClientPartyId: string | undefined,
): { firmId: string; clientPartyId: string } {
  const firmId = requireFirmScope(principal);
  const clientPartyId = clientPartyScope(principal) ?? requestedClientPartyId;
  if (!clientPartyId) {
    throw new DomainError("MISSING_CLIENT", "clientPartyId is required", 400);
  }
  assertClientPartyScope(principal, clientPartyId);
  return { firmId, clientPartyId };
}
