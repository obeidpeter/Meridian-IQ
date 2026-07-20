import { and, eq, or } from "drizzle-orm";
import {
  getDb,
  engagementsTable,
  invoicesTable,
  type Role,
} from "@workspace/db";
import { DomainError } from "../errors";

// Principal resolved from the request (see auth middleware). firmId is present
// for firm-scoped roles; operator/auditor/bank roles are cross-tenant.
// buyerPartyId is present for buyer_user principals (Buyer Rails), which carry
// no firm and are scoped to their buyer Party at the route level.
export interface Principal {
  userId: string;
  role: Role;
  firmId: string | null;
  clientPartyId: string | null;
  buyerPartyId: string | null;
  // Machine principals ONLY (firm API keys — modules/integrations/api-keys.ts,
  // resolved in middleware/principal.ts): when present, this explicit list
  // REPLACES the role matrix in can() — the key grants exactly the
  // capabilities minted onto it (a vetted machine-safe subset), never a
  // role's full set. Absent on every human principal, whose capabilities
  // keep coming from ROLE_CAPABILITIES unchanged.
  capabilities?: readonly Capability[];
}

// Capability strings used to gate actions. Kept coarse-grained and stable so
// downstream surfaces can reference them. Declared once; the Capability union
// type derives from this list, so a new capability is added in one place.
const ALL = [
  "invoice.read",
  "invoice.write",
  "invoice.submit",
  "engagement.read",
  "engagement.write",
  "party.read",
  "party.write",
  "party.merge",
  "confirmation.read",
  "confirmation.write",
  "buyer.verify",
  "settlement.write",
  "console.portfolio.read",
  "pipeline.write",
  "billing.read",
  "billing.write",
  // Platform-global pricing (billing_tiers). Operator-only: the tier table has
  // no firm scope, so a firm_admin holding billing.write must NOT edit it
  // (SEC-04). billing.write stays firm-scoped (own subscription, own statements).
  "billing.tiers.write",
  "operator.queue.read",
  "operator.queue.act",
  "catalogue.write",
  "consent.read",
  "consent.write",
  "flags.read",
  "flags.write",
  "audit.read",
  "audit.export",
  "identity.read",
  "identity.write",
  "invitation.read",
  "invitation.write",
  "messaging.send",
  "statement.read",
  "statement.write",
  "reconciliation.read",
  "reconciliation.act",
  "b2c.read",
  "b2c.write",
  "buyer.rails.read",
  "confirmation.respond",
  "settlement.flag",
  "clients.import",
  "theme.write",
  "certification.read",
  "certification.write",
  "connector.read",
  "connector.write",
  // Clerk v0 (Task #40). claims.read is broad reference data; claims.write /
  // claims.approve are operator-only because claim records are platform-global
  // governance data (same rationale as billing.tiers.write). clerk.use gates
  // every AI surface (capture, review, Ask Clerk) — operator-only.
  "claims.read",
  "claims.write",
  "claims.approve",
  "clerk.use",
  // Clerk expansion A: client-facing surfaces. capture = submit documents /
  // voice notes as intake cases (review stays operator-only via clerk.use);
  // ask = the register-grounded Q&A. Both are budget-capped per firm.
  "clerk.capture",
  "clerk.ask",
] as const;

export type Capability = (typeof ALL)[number];

const READ_ONLY: Capability[] = ALL.filter(
  (c) => c.endsWith(".read") || c === "audit.export",
);

// Role-permission matrix (Appendix C).
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  firm_admin: [
    "invoice.read",
    "invoice.write",
    "invoice.submit",
    "engagement.read",
    "engagement.write",
    "party.read",
    "party.write",
    "confirmation.read",
    "confirmation.write",
    "settlement.write",
    "console.portfolio.read",
    "pipeline.write",
    "billing.read",
    "billing.write",
    "consent.read",
    "consent.write",
    "flags.read",
    "identity.read",
    // Firm admins onboard their own staff/clients via the invite flow (IDN-01).
    // They still lack identity.write (direct user creation stays operator-only);
    // an invitation is the self-serve, RLS-scoped path to add a firm member.
    "invitation.read",
    "invitation.write",
    "messaging.send",
    "statement.read",
    "statement.write",
    "reconciliation.read",
    "reconciliation.act",
    "b2c.read",
    "b2c.write",
    "clients.import",
    "theme.write",
    "certification.read",
    "certification.write",
    "connector.read",
    "connector.write",
    "claims.read",
    "clerk.capture",
    "clerk.ask",
  ],
  firm_staff: [
    "invoice.read",
    "invoice.write",
    "invoice.submit",
    "engagement.read",
    "engagement.write",
    "party.read",
    "party.write",
    "confirmation.read",
    "settlement.write",
    "console.portfolio.read",
    // Staff submit on behalf of clients, so they may SEE consent status (the
    // submit path enforces it); granting/revoking stays with the client and
    // the firm admin (Appendix C).
    "consent.read",
    "messaging.send",
    "statement.read",
    "statement.write",
    "reconciliation.read",
    "reconciliation.act",
    "b2c.read",
    "b2c.write",
    "certification.read",
    "certification.write",
    "claims.read",
    "clerk.capture",
    "clerk.ask",
  ],
  client_user: [
    "invoice.read",
    "invoice.write",
    "invoice.submit",
    "engagement.read",
    "party.read",
    // Capturing a new customer is part of writing an invoice. The write
    // surface stays narrow: createParty adds a shared spine entry, and
    // updateParty confines a client_user to its OWN party (SEC-03 — the
    // invoice-reference fallback is firm-only).
    "party.write",
    "confirmation.read",
    "consent.read",
    "consent.write",
    "statement.read",
    "reconciliation.read",
    "b2c.read",
    "clerk.capture",
    // Ask Clerk for clients (SEC-03 subset): ask.ts offers a client asker
    // only the client-safe data intents and pins every lookup to the caller's
    // OWN party (from the principal, never model output). Firm-internal
    // surfaces that share this capability must refuse client_user explicitly
    // (see GET /clerk/digest) — the capability was widened for Ask, not them.
    "clerk.ask",
  ],
  operator: [
    "invoice.read",
    "operator.queue.read",
    "operator.queue.act",
    "catalogue.write",
    "party.read",
    "party.merge",
    "flags.read",
    "flags.write",
    "billing.tiers.write",
    "audit.read",
    "audit.export",
    "consent.read",
    "identity.read",
    "identity.write",
    "invitation.read",
    "invitation.write",
    "messaging.send",
    "claims.read",
    "claims.write",
    "claims.approve",
    "clerk.use",
    "clerk.capture",
    "clerk.ask",
  ],
  bank_user: ["buyer.verify", "audit.read"],
  // Buyer Rails role (Appendix C "Y (buyer org)"): verification, confirmation
  // responses and payment flags on invoices addressed to the buyer's own Party.
  buyer_user: [
    "buyer.verify",
    "buyer.rails.read",
    "confirmation.respond",
    "settlement.flag",
  ],
  auditor: READ_ONLY,
};

export function can(principal: Principal, capability: Capability): boolean {
  // Capability-override principals (firm API keys) are judged on their
  // explicit grant list alone; the role matrix never applies to them (their
  // synthetic "api_key" role has no matrix row, so falling through would
  // deny everything — and MUST keep denying everything if the override is
  // ever absent: fail closed).
  if (principal.capabilities) return principal.capabilities.includes(capability);
  return ROLE_CAPABILITIES[principal.role]?.includes(capability) ?? false;
}

export function assertCan(principal: Principal, capability: Capability): void {
  if (!can(principal, capability)) {
    throw new DomainError(
      "FORBIDDEN",
      `Role ${principal.role} lacks capability ${capability}`,
      403,
    );
  }
}

// Sub-tenant scoping for the client_user role (SEC-03). A client_user
// membership is bound to a single client Party (principal.clientPartyId), but
// firm-keyed RLS shares the whole firm across all its client_users. Without this
// guard a client_user could read a sibling client's data by passing another
// party's id (or via un-scoped firm-wide list queries). This narrows a
// client_user to its own client party; firm_admin/firm_staff (who legitimately
// act across the firm's clients) and cross-tenant roles pass through unchanged.
export function assertClientPartyScope(
  principal: Principal,
  clientPartyId: string,
): void {
  if (principal.role !== "client_user") return;
  if (principal.clientPartyId !== clientPartyId) {
    throw new DomainError(
      "CROSS_CLIENT",
      "Resource is not within your client scope",
      403,
    );
  }
}

// The client party a client_user is confined to, or null for any other role
// (which is not sub-tenant scoped). Used to constrain firm-wide list queries.
export function clientPartyScope(principal: Principal): string | null {
  return principal.role === "client_user" ? principal.clientPartyId : null;
}

// Narrows a list query's clientPartyId filter to the caller's sub-tenant scope
// (SEC-03): a client_user is confined to its own client party, so an explicit
// sibling id is rejected and the filter is always pinned to its own party;
// other roles keep whatever filter they asked for.
export function narrowToClientPartyScope(
  principal: Principal,
  clientPartyId: string | undefined,
): string | undefined {
  if (clientPartyId) assertClientPartyScope(principal, clientPartyId);
  const scope = clientPartyScope(principal);
  if (scope) clientPartyId = scope;
  return clientPartyId;
}

// Row-level tenant isolation (CON-01, SEC-02/03). Returns the firmId a
// firm-scoped principal is allowed to see, or null for cross-tenant staff
// (operator/auditor) who may pass an explicit firmId filter instead.
export function tenantFirmId(principal: Principal): string | null {
  if (principal.role === "operator" || principal.role === "auditor") {
    return null;
  }
  if (!principal.firmId) {
    throw new DomainError(
      "NO_TENANT",
      "Principal is not bound to a firm",
      403,
    );
  }
  return principal.firmId;
}

// Like tenantFirmId, but for writes that must land in a firm's tenant: a
// cross-tenant principal (operator/auditor, which tenantFirmId maps to null)
// has no firm to write into, so it is rejected instead of passed through.
export function requireFirmScope(principal: Principal): string {
  const firmId = tenantFirmId(principal);
  if (!firmId) {
    throw new DomainError(
      "NO_TENANT",
      "A firm-scoped principal is required",
      403,
    );
  }
  return firmId;
}

// Guards a resource's firmId against the principal's tenant. Cross-tenant staff
// are allowed; everyone else must match.
export function assertSameTenant(
  principal: Principal,
  resourceFirmId: string,
): void {
  const tenant = tenantFirmId(principal);
  if (tenant !== null && tenant !== resourceFirmId) {
    throw new DomainError(
      "CROSS_TENANT",
      "Cross-tenant access denied",
      403,
    );
  }
}

// Buyer-party scoping (BR-01..BR-05). buyer_user principals carry no firm and
// run with RLS bypassed (like operator/auditor), so this route-level guard is
// the tenancy boundary: a buyer principal may only touch resources addressed to
// its own buyer Party. Every buyer-rails handler must call it before touching
// invoice, confirmation or settlement data.
export function buyerPartyId(principal: Principal): string {
  if (principal.role !== "buyer_user" || !principal.buyerPartyId) {
    throw new DomainError(
      "NO_BUYER_PARTY",
      "A buyer-scoped principal is required",
      403,
    );
  }
  return principal.buyerPartyId;
}

export function assertBuyerPartyAccess(
  principal: Principal,
  resourceBuyerPartyId: string,
): void {
  if (buyerPartyId(principal) !== resourceBuyerPartyId) {
    throw new DomainError(
      "CROSS_BUYER",
      "Resource is not addressed to your buyer organization",
      403,
    );
  }
}

// True when the firm has an engagement with the party — the single definition
// of "this client belongs to this firm", shared by the tenancy guard below and
// the invitation flow (which enforces it for every role, operators included).
export async function firmEngagesParty(
  firmId: string,
  partyId: string,
): Promise<boolean> {
  const [engagement] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, partyId),
      ),
    )
    .limit(1);
  return Boolean(engagement);
}

// Party-scoped tenant guard. Parties are shared reference data; a firm-scoped
// principal may only touch a party it has an engagement with. Cross-tenant
// staff (operator, auditor) are unrestricted. Prevents cross-tenant IDOR on
// party and consent resources (SEC-02/03, CON-01).
export async function assertPartyAccess(
  principal: Principal,
  partyId: string,
): Promise<void> {
  // A client_user may only touch its own client party (SEC-03), even within its
  // firm; firm staff/admin may touch any party the firm engages.
  assertClientPartyScope(principal, partyId);
  const tenant = tenantFirmId(principal);
  if (tenant === null) return;
  if (!(await firmEngagesParty(tenant, partyId))) {
    throw new DomainError("CROSS_TENANT", "Party is not in your tenant", 403);
  }
}

// Like assertPartyAccess, but with a fallback for firm staff/admin: buyer
// (and occasionally supplier) parties are usually not engagement subjects, yet
// firm-scoped staff must still be able to read/correct a party that appears on
// one of the firm's invoices — e.g. fixing a buyer TIN that failed a
// transmission. client_users get NO fallback: they stay confined to their own
// client party (SEC-03).
export async function assertPartyAccessOrInvoiceRef(
  principal: Principal,
  partyId: string,
): Promise<void> {
  try {
    await assertPartyAccess(principal, partyId);
    return;
  } catch (err) {
    const tenant = tenantFirmId(principal);
    if (
      principal.role === "client_user" ||
      tenant === null ||
      !(err instanceof DomainError) ||
      err.code !== "CROSS_TENANT"
    ) {
      throw err;
    }
    const [ref] = await getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.firmId, tenant),
          or(
            eq(invoicesTable.buyerPartyId, partyId),
            eq(invoicesTable.supplierPartyId, partyId),
          ),
        ),
      )
      .limit(1);
    if (!ref) throw err;
  }
}
