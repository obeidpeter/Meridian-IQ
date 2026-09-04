import { sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkInferenceCallsTable,
} from "@workspace/db";
import { assertCan, type Principal } from "../auth/rbac";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { clerkFirmHasActivePermit } from "./budget";

function requireOperator(
  principal: Principal | undefined,
  write: boolean,
): asserts principal is Principal {
  if (!principal)
    throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
  assertCan(principal, write ? "operator.queue.act" : "operator.queue.read");
  if (principal.role !== "operator")
    throw new DomainError(
      "FORBIDDEN",
      "Only operators can reconcile Clerk spend",
      403,
    );
}

export async function listExpiredClerkReservations(
  principal: Principal | undefined,
  afterId?: string,
  limit = 100,
) {
  requireOperator(principal, false);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError(
      "INVALID_INPUT",
      "Limit must be between 1 and 100",
      400,
    );
  return runInBypassContext(async () => {
    const result = await getDb().execute(sql`
      SELECT id, firm_id AS "firmId", reserved_tokens::text AS "reservedTokens",
        created_at AS "createdAt", expires_at AS "expiresAt"
      FROM clerk_reservations
      WHERE settled_at IS NULL AND expires_at <= now()
        ${afterId ? sql`AND id > ${afterId}::uuid` : sql``}
      ORDER BY id LIMIT ${limit}
    `);
    return result.rows;
  });
}

export async function reconcileExpiredClerkReservation(
  principal: Principal | undefined,
  reservationId: string,
  input: { reason: string; confirmedStopped: true; chargedTokens?: number },
): Promise<{ inferenceCallId: string; replayed: boolean }> {
  requireOperator(principal, true);
  if (
    input.confirmedStopped !== true ||
    input.reason.trim().length < 10 ||
    input.reason.length > 1_000
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "Confirm provider execution stopped and provide a reconciliation reason",
      400,
    );
  }
  return runInBypassContext(async () => {
    const result = await getDb()
      .execute(sql`SELECT id, firm_id, reserved_tokens::text,
      inference_call_id, expires_at <= now() AS expired
      FROM clerk_reservations WHERE id = ${reservationId}::uuid FOR UPDATE`);
    const reservation = result.rows[0] as
      | {
          id: string;
          firm_id: string;
          reserved_tokens: string;
          inference_call_id: string | null;
          expired: boolean;
        }
      | undefined;
    if (!reservation)
      throw new DomainError("NOT_FOUND", "Reservation not found", 404);
    if (reservation.inference_call_id)
      return { inferenceCallId: reservation.inference_call_id, replayed: true };
    if (!reservation.expired || clerkFirmHasActivePermit(reservation.firm_id)) {
      throw new DomainError(
        "RESERVATION_ACTIVE",
        "The reservation has not expired or still has local provider work",
        409,
      );
    }
    const charge = input.chargedTokens ?? Number(reservation.reserved_tokens);
    if (
      !Number.isSafeInteger(charge) ||
      charge < Number(reservation.reserved_tokens) ||
      charge > 2_147_483_647
    ) {
      throw new DomainError(
        "INVALID_INPUT",
        "Reconciliation must charge at least the reserved tokens within the ledger limit",
        400,
      );
    }
    const [call] = await getDb()
      .insert(clerkInferenceCallsTable)
      .values({
        firmId: reservation.firm_id,
        purpose: "reservation_recovery",
        model: "unknown-provider",
        promptVersion: "reservation-recovery-v1",
        inputRef: reservation.id,
        outputJson: null,
        schemaValid: false,
        outcome: "error",
        errorText:
          "Operator reconciled uncertain provider spend conservatively; see audit evidence.",
        promptTokens: charge,
        completionTokens: 0,
      })
      .returning({ id: clerkInferenceCallsTable.id });
    await getDb()
      .execute(sql`UPDATE clerk_reservations SET settled_at = now(), inference_call_id = ${call.id}
      WHERE id = ${reservation.id}::uuid`);
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      firmId: reservation.firm_id,
      action: "clerk.reservation_reconciled",
      entityType: "clerk_reservation",
      entityId: reservation.id,
      after: {
        chargedTokens: charge,
        inferenceCallId: call.id,
        reason: input.reason.trim(),
        confirmedStopped: true,
      },
    });
    return { inferenceCallId: call.id, replayed: false };
  });
}
