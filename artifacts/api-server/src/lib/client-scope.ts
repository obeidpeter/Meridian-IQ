import {
  assertClientPartyScope,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
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

// The clerk read surfaces' bound-firm resolver, distinct from the THREE
// firm resolvers above/in rbac by its failure shape:
//  - rbac's requireFirmScope refuses cross-tenant staff with a 403;
//  - rbac's firmScope is the same bound-firm fallback but answers 403;
//  - resolveClientAnalyticsScope (above) rides requireFirmScope.
// This one answers 400 NO_TENANT — which is contract-observable on the clerk
// read surfaces (digest, client statements, usage, advisory briefs), so do
// NOT swap it to firmScope.
export function resolveBoundFirm(principal: Principal, surface: string): string {
  const tenant = tenantFirmId(principal) ?? principal.firmId;
  if (!tenant) {
    throw new DomainError(
      "NO_TENANT",
      `A firm scope is required for ${surface}`,
      400,
    );
  }
  return tenant;
}

// Bound firm + SEC-03 client-party wall for the clerk client surfaces: a
// client_user resolves to its OWN party whatever the query says; a firm
// principal must name the client. assertClientPartyScope is the sibling wall
// (no-op for firm principals, 403 for a client_user naming another party) —
// firm-keyed RLS alone is NOT a sibling wall, so the party is enforced here
// regardless.
export function resolveBoundClientScope(
  principal: Principal,
  requestedClientPartyId: string | undefined,
  surface: string,
): { firmId: string; clientPartyId: string } {
  const firmId = resolveBoundFirm(principal, surface);
  const clientPartyId = clientPartyScope(principal) ?? requestedClientPartyId;
  if (!clientPartyId) {
    throw new DomainError("MISSING_CLIENT", "clientPartyId is required", 400);
  }
  assertClientPartyScope(principal, clientPartyId);
  return { firmId, clientPartyId };
}
