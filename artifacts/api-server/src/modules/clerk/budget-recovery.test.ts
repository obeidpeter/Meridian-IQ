import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  getDb,
  runInBypassContext,
  clerkReservationsTable,
  firmsTable,
  clerkInferenceCallsTable,
  auditEventsTable,
} from "@workspace/db";
import { acquireFirmClerkBudgetPermit } from "./budget.ts";
import { reconcileExpiredClerkReservation } from "./budget-recovery.ts";
import router from "../../routes/clerk-reservations.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import {
  crossTenantPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";

after(closeAllServers);
const operator = crossTenantPrincipal("operator");
const reason =
  "Provider process stopped; charging reserved spend after response loss";

async function expiredReservation() {
  const firmId = randomUUID();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Recovery test ${firmId}` });
  const permit = await acquireFirmClerkBudgetPermit(firmId, 100);
  assert.ok(permit);
  await permit.release();
  const result = await pool.query(
    "UPDATE clerk_reservations SET expires_at = now() - interval '1 hour' WHERE firm_id = $1 RETURNING id",
    [firmId],
  );
  return { firmId, id: result.rows[0].id as string };
}

test("only an authenticated operator can list and reconcile expired reservations; reconciliation charges and audits once", async () => {
  const reservation = await expiredReservation();
  const staff = await listen(appFor(firmPrincipal(reservation.firmId), router));
  const ops = await listen(appFor(operator, router));
  const path = `/operator/clerk-reservations/${reservation.id}/reconcile`;
  assert.equal(
    (await fetch(`${staff}/operator/clerk-reservations`)).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${staff}${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ reason, confirmedStopped: true }),
      })
    ).status,
    403,
  );
  await assert.rejects(
    reconcileExpiredClerkReservation(undefined, reservation.id, {
      reason,
      confirmedStopped: true,
    }),
    { status: 401 },
  );
  assert.equal(
    (
      await fetch(`${ops}${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          reason,
          confirmedStopped: true,
          chargedTokens: 99,
        }),
      })
    ).status,
    400,
  );
  const listing = await fetch(`${ops}/operator/clerk-reservations`);
  assert.equal(listing.status, 200);
  const listed = (await listing.json()) as { reservations: { id: string }[] };
  assert.ok(listed.reservations.some((row) => row.id === reservation.id));
  const responses = await Promise.all(
    [1, 2].map(() =>
      fetch(`${ops}${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ reason, confirmedStopped: true }),
      }),
    ),
  );
  assert.ok(responses.every((res) => res.status === 200));
  const outcomes = (await Promise.all(responses.map((res) => res.json()))) as {
    inferenceCallId: string;
    replayed: boolean;
  }[];
  assert.equal(new Set(outcomes.map((entry) => entry.inferenceCallId)).size, 1);
  assert.equal(outcomes.filter((entry) => !entry.replayed).length, 1);
  const calls = await db
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.firmId, reservation.firmId));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].promptTokens, 100);
  const evidence = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.entityId, reservation.id));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].actorId, operator.userId);
  assert.equal(evidence[0].action, "clerk.reservation_reconciled");
  assert.equal(evidence[0].after?.reason, reason);
  const next = await acquireFirmClerkBudgetPermit(reservation.firmId, 100);
  assert.ok(
    next,
    "crash recovery reopens firm admission without refunding uncertain spend",
  );
  await next.append({
    firmId: reservation.firmId,
    purpose: "extract_invoice",
    model: "test",
    promptVersion: "test",
    inputRef: randomUUID(),
    outcome: "ok",
    schemaValid: true,
    promptTokens: 10,
    completionTokens: 0,
  });
  await next.release();
});

test("an active reservation is not reconciled prematurely", async () => {
  const reservation = await expiredReservation();
  await pool.query(
    "UPDATE clerk_reservations SET expires_at = now() + interval '1 hour' WHERE id = $1",
    [reservation.id],
  );
  await assert.rejects(
    reconcileExpiredClerkReservation(operator, reservation.id, {
      reason,
      confirmedStopped: true,
    }),
    { code: "RESERVATION_ACTIVE" },
  );
  assert.equal(
    (
      await db
        .select()
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.firmId, reservation.firmId))
    ).length,
    0,
  );
});

test("a late provider settlement after operator recovery adds only excess usage, exactly once", async () => {
  const modulePath = `./budget.ts?late-process=${randomUUID()}`;
  const replica = (await import(modulePath)) as typeof import("./budget.ts");
  for (const actual of [50, 150]) {
    const firmId = randomUUID();
    await db
      .insert(firmsTable)
      .values({ id: firmId, name: `Late recovery ${firmId}` });
    const permit = await replica.acquireFirmClerkBudgetPermit(firmId, 100);
    assert.ok(permit);
    try {
      const reservation = await pool.query(
        "UPDATE clerk_reservations SET expires_at = now() - interval '1 hour' WHERE firm_id = $1 RETURNING id",
        [firmId],
      );
      await reconcileExpiredClerkReservation(operator, reservation.rows[0].id, {
        reason,
        confirmedStopped: true,
      });
      const row = {
        firmId,
        purpose: "extract_invoice",
        model: "test",
        promptVersion: "test",
        inputRef: randomUUID(),
        outcome: "ok" as const,
        schemaValid: true,
        promptTokens: actual,
        completionTokens: 0,
      };
      await permit.append(row);
      await permit.append(row);
      const calls = await db
        .select()
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.firmId, firmId));
      assert.equal(calls.length, 2);
      assert.equal(
        calls.reduce(
          (sum, call) =>
            sum + (call.promptTokens ?? 0) + (call.completionTokens ?? 0),
          0,
        ),
        Math.max(100, actual),
      );
    } finally {
      await permit.release();
    }
  }
});

test("even bypass-scoped application sessions cannot delete uncertain or reconciled reservations", async () => {
  const reservation = await expiredReservation();
  const deletion = () =>
    runInBypassContext(() =>
      getDb()
        .delete(clerkReservationsTable)
        .where(eq(clerkReservationsTable.id, reservation.id)),
    );
  await assert.rejects(deletion(), (err: unknown) => {
    const failure = err as { code?: string; cause?: { code?: string } };
    return (failure.cause?.code ?? failure.code) === "42501";
  });
  await reconcileExpiredClerkReservation(operator, reservation.id, {
    reason,
    confirmedStopped: true,
  });
  await assert.rejects(deletion(), (err: unknown) => {
    const failure = err as { code?: string; cause?: { code?: string } };
    return (failure.cause?.code ?? failure.code) === "42501";
  });
  const [retained] = await db
    .select()
    .from(clerkReservationsTable)
    .where(eq(clerkReservationsTable.id, reservation.id));
  assert.ok(retained.settledAt);
  assert.ok(retained.inferenceCallId);
});
