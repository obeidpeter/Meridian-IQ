import { and, eq } from "drizzle-orm";
import { db, engagementsTable, type Role } from "@workspace/db";
import { DomainError } from "../errors";

// Principal resolved from the request (see auth middleware). firmId is present
// for firm-scoped roles; operator/auditor/bank roles are cross-tenant.
export interface Principal {
  userId: string;
  role: Role;
  firmId: string | null;
  clientPartyId: string | null;
}

// Capability strings used to gate actions. Kept coarse-grained and stable so
// downstream surfaces can reference them.
export type Capability =
  | "invoice.read"
  | "invoice.write"
  | "invoice.submit"
  | "engagement.read"
  | "engagement.write"
  | "party.read"
  | "party.write"
  | "party.merge"
  | "confirmation.read"
  | "confirmation.write"
  | "buyer.verify"
  | "settlement.write"
  | "console.portfolio.read"
  | "billing.read"
  | "operator.queue.read"
  | "operator.queue.act"
  | "catalogue.write"
  | "consent.read"
  | "consent.write"
  | "flags.read"
  | "flags.write"
  | "audit.read"
  | "audit.export"
  | "identity.read"
  | "identity.write"
  | "messaging.send";

const ALL: Capability[] = [
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
  "billing.read",
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
  "messaging.send",
];

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
    "billing.read",
    "consent.read",
    "consent.write",
    "flags.read",
    "identity.read",
    "messaging.send",
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
    "messaging.send",
  ],
  client_user: [
    "invoice.read",
    "invoice.write",
    "invoice.submit",
    "engagement.read",
    "party.read",
    "confirmation.read",
    "consent.read",
    "consent.write",
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
    "audit.read",
    "audit.export",
    "consent.read",
    "identity.read",
    "identity.write",
    "messaging.send",
  ],
  bank_user: ["buyer.verify", "audit.read"],
  auditor: READ_ONLY,
};

export function can(principal: Principal, capability: Capability): boolean {
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

// Party-scoped tenant guard. Parties are shared reference data; a firm-scoped
// principal may only touch a party it has an engagement with. Cross-tenant
// staff (operator, auditor) are unrestricted. Prevents cross-tenant IDOR on
// party and consent resources (SEC-02/03, CON-01).
export async function assertPartyAccess(
  principal: Principal,
  partyId: string,
): Promise<void> {
  const tenant = tenantFirmId(principal);
  if (tenant === null) return;
  const [engagement] = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, tenant),
        eq(engagementsTable.clientPartyId, partyId),
      ),
    )
    .limit(1);
  if (!engagement) {
    throw new DomainError("CROSS_TENANT", "Party is not in your tenant", 403);
  }
}
