import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, pool, runInBypassContext } from "@workspace/db";
import {
  productionPilotOperatorDependencies,
  provisionProductionPilotOperator,
  type PilotOperatorDependencies,
} from "./pilot-operator";

test("database failure rolls back operator, membership, audit and claim together", async () => {
  const email = `pilot-${randomUUID()}@example.com`;
  const rollback = new Error("intentional test rollback");
  let userId = "";

  const existingClaim = await pool.query(
    `SELECT 1 FROM production_bootstrap_claims
      WHERE key = 'first-production-operator'`,
  );
  assert.equal(existingClaim.rowCount, 0, "test database bootstrap already consumed");

  const dependencies: PilotOperatorDependencies = {
    ...productionPilotOperatorDependencies,
    isConsumed: async () => false,
    findRealOperator: async () => null,
    withLock: (fn) =>
      runInBypassContext(async () => {
        const result = await fn();
        const createdRows = await getDb().execute<{
          id: string;
          memberships: number;
          audits: number;
          claims: number;
        }>(sql`
          SELECT u.id,
                 (SELECT count(*)::int FROM memberships m
                   WHERE m.user_id = u.id AND m.role = 'operator') memberships,
                 (SELECT count(*)::int FROM audit_events a
                   WHERE a.entity_id = u.id::text
                     AND a.action = 'operator.bootstrap') audits,
                 (SELECT count(*)::int FROM production_bootstrap_claims c
                   WHERE c.key = 'first-production-operator'
                     AND c.operator_user_id = u.id) claims
            FROM users u
           WHERE u.email = ${email}
        `);
        const [created] = createdRows.rows;
        assert.ok(created);
        userId = created.id;
        assert.equal(created.memberships, 1);
        assert.equal(created.audits, 1);
        assert.equal(created.claims, 1);
        assert.equal(result, "provisioned");
        throw rollback;
      }),
  };

  await assert.rejects(
    provisionProductionPilotOperator(
      {
        NODE_ENV: "production",
        PILOT_OPERATOR_EMAIL: email,
        PILOT_OPERATOR_FULL_NAME: "Atomic Rollback Test",
        PILOT_OPERATOR_PASSWORD: "unique-test-password-1234",
      },
      dependencies,
    ),
    (error: unknown) => error === rollback,
  );

  const persisted = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM users WHERE email = $1) users,
       (SELECT count(*)::int FROM memberships
         WHERE user_id = $2::uuid) memberships,
       (SELECT count(*)::int FROM audit_events
         WHERE entity_id = $2::text) audits,
       (SELECT count(*)::int FROM production_bootstrap_claims
         WHERE key = 'first-production-operator') claims`,
    [email, userId],
  );
  assert.deepEqual(persisted.rows[0], {
    users: 0,
    memberships: 0,
    audits: 0,
    claims: 0,
  });
});