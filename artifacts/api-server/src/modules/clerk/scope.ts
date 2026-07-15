import { runRequestContext } from "@workspace/db";

// Short, explicit DB scope for the model-calling Clerk paths.
//
// The capture/batch/ask routes run OUTSIDE the per-request transaction
// (app.ts NO_CONTEXT_ROUTES): a multi-second provider call — up to eleven of
// them for a full batch — must never pin a pooled connection or run into the
// 30s request-transaction cap. Each DB stage instead commits in its own short
// transaction opened here, with the SAME tenancy posture tenantContext would
// have given the request: a firm-attributed call gets the firm-keyed RLS
// policies (migration 0009's clerk tables), cross-tenant staff (no firm) run
// bypass. Committing stage-by-stage is also what lets the gateway's ledger
// rows reference the case row mid-flight — the case exists before the model
// is called, and survives whatever happens after.
export async function inClerkScope<T>(
  firmId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runRequestContext({ bypass: !firmId, firmId: firmId ?? null }, fn);
}
