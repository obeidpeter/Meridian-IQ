import { eq } from "drizzle-orm";
import { getDb, bankStatementsTable, type BankStatement } from "@workspace/db";
import {
  assertClientPartyScope,
  assertSameTenant,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";

// Load one bank statement under the statements routes' tenancy posture —
// NOT_FOUND when the id does not exist, then firm match (assertSameTenant)
// plus the SEC-03 client narrowing to the statement's own client party
// (assertClientPartyScope, which throws its own CROSS_CLIENT — this surface
// does NOT collapse to 404). ONE home (refactor round 7) shared by the clerk
// reconciliation lanes (narration-match, reconcile-assist) and the statements
// detail routes, which previously carried verbatim copies of this ritual.
// getDb() resolves the ambient context at call time, so each
// caller keeps its own transaction posture (NO_CONTEXT or in-transaction)
// unchanged.
export async function loadStatementScoped(
  principal: Principal,
  statementId: string,
): Promise<BankStatement> {
  const [statement] = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, statementId))
    .limit(1);
  if (!statement) {
    throw new DomainError("NOT_FOUND", "Statement not found", 404);
  }
  assertSameTenant(principal, statement.firmId);
  assertClientPartyScope(principal, statement.clientPartyId);
  return statement;
}
