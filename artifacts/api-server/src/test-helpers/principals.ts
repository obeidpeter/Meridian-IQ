import { randomUUID } from "node:crypto";
import type { Principal } from "../modules/auth/rbac";

// Principal builders (refactoring survey item 28). Test files hand-rolled
// the same five-field Principal literal ~130 times; these builders are the
// one home for each role's correct shape, so a future Principal field lands
// in ONE place instead of every suite. Pass userId only when the test
// asserts on it later (audit rows, approvals); the default is a fresh UUID,
// exactly what the literals used.

export function firmPrincipal(
  firmId: string,
  opts: { userId?: string; role?: "firm_admin" | "firm_staff" } = {},
): Principal {
  return {
    userId: opts.userId ?? randomUUID(),
    role: opts.role ?? "firm_admin",
    firmId,
    clientPartyId: null,
    buyerPartyId: null,
  };
}

export function clientPrincipal(
  firmId: string,
  clientPartyId: string,
  opts: { userId?: string } = {},
): Principal {
  return {
    userId: opts.userId ?? randomUUID(),
    role: "client_user",
    firmId,
    clientPartyId,
    buyerPartyId: null,
  };
}

export function buyerPrincipal(
  buyerPartyId: string,
  opts: { userId?: string } = {},
): Principal {
  return {
    userId: opts.userId ?? randomUUID(),
    role: "buyer_user",
    firmId: null,
    clientPartyId: null,
    buyerPartyId,
  };
}

// operator / auditor / bank_user — the cross-tenant roles: no firm, no party.
export function crossTenantPrincipal(
  role: "operator" | "auditor" | "bank_user",
  opts: { userId?: string } = {},
): Principal {
  return {
    userId: opts.userId ?? randomUUID(),
    role,
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
}
