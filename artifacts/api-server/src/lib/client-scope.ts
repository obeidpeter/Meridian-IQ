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
//
// What this ENFORCES, exactly — it is NOT assertPartyAccess (rbac.ts):
//  - the firm comes from the principal (requireFirmScope — cross-tenant
//    staff, who have no firm, are refused);
//  - a client_user is walled to its own party (the SEC-03 sibling refusal);
//  - it does NOT check firmEngagesParty: a firm principal may name ANY party
//    id here, including one its firm never engaged (or another firm's
//    client), without a 403.
// Why that is safe FOR THESE SURFACES: every miner behind this resolver
// filters by BOTH the returned firmId and clientPartyId in the same query
// (and RLS pins the transaction to the principal's firm), so a foreign or
// un-engaged party id can only select from the caller's own firm's rows —
// an empty result, never another tenant's data. The trade is a quiet empty
// answer instead of assertPartyAccess's CROSS_TENANT 403, bought back as one
// less engagement lookup per analytics call. Do NOT reuse this resolver for
// a surface that WRITES, or whose reads are keyed by party id alone — those
// need the real engagement check (assertPartyAccess).
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
