import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  getDb,
  membershipsTable,
  pool,
  runInBypassContext,
  usersTable,
} from "@workspace/db";
import { PRODUCTION_DEMO_EMAILS } from "../modules/auth/session";
import {
  acquirePilotOperatorLocks,
  PILOT_OPERATOR_LOCK_ID,
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

// R112: the rollback test above substitutes the lock wrapper and two lookups
// with fakes. This one runs every production dependency — the lock
// statements, the claim read, the operator lookup, the hash, the inserts,
// the audit append and the claim insert — against real Postgres, inside a
// transaction the test rolls back, and proves the two boot-time behaviours
// the fakes could only assert by construction: a second boot stops at the
// claim, and an existing operator is consumed instead of a second identity.
test("real dependencies: the locks are held, the claim short-circuits the next boot, and an existing operator is consumed (R112)", async () => {
  const rollback = new Error("intentional test rollback");
  const email = `pilot-${randomUUID()}@example.com`;
  const existingEmail = `operator-${randomUUID()}@example.com`;
  const env = {
    NODE_ENV: "production",
    PILOT_OPERATOR_EMAIL: email,
    PILOT_OPERATOR_FULL_NAME: "Real Dependency Test",
    PILOT_OPERATOR_PASSWORD: "unique-test-password-1234",
  };
  const existingClaim = await pool.query(
    `SELECT 1 FROM production_bootstrap_claims
      WHERE key = 'first-production-operator'`,
  );
  assert.equal(existingClaim.rowCount, 0, "test database bootstrap already consumed");

  // Every dependency is the production one. The lock wrapper is the only
  // substitution: the bypass transaction each phase opens below IS the one
  // the real wrapper would open, and it takes the same locks, so the whole
  // boot can be rolled back at the end.
  const onAmbientTransaction: PilotOperatorDependencies = {
    ...productionPilotOperatorDependencies,
    withLock: async (fn) => {
      await acquirePilotOperatorLocks();
      return fn();
    },
  };
  const rowsFor = async (address: string) => {
    const result = await getDb().execute<{
      users: number;
      memberships: number;
      audits: number;
      claims: number;
    }>(sql`
      SELECT (SELECT count(*)::int FROM users WHERE email = ${address}) users,
             (SELECT count(*)::int FROM memberships m
                JOIN users u ON u.id = m.user_id
               WHERE u.email = ${address} AND m.role = 'operator') memberships,
             (SELECT count(*)::int FROM audit_events a
                JOIN users u ON a.entity_id = u.id::text
               WHERE u.email = ${address}
                 AND a.action LIKE 'operator.bootstrap%') audits,
             (SELECT count(*)::int FROM production_bootstrap_claims c
                JOIN users u ON c.operator_user_id = u.id
               WHERE u.email = ${address}
                 AND c.key = 'first-production-operator') claims
    `);
    return result.rows[0];
  };

  // Phase A — an empty operator book. The shared scratch database carries
  // operators from other suites, so this branch pins findRealOperator to
  // "none" (as the rollback test does); every other dependency is real.
  await assert.rejects(
    runInBypassContext(async () => {
      await acquirePilotOperatorLocks();
      const locks = await getDb().execute<{ advisory: number; tables: number }>(
        sql`
          SELECT (SELECT count(*)::int FROM pg_locks
                   WHERE locktype = 'advisory'
                     AND objid = ${PILOT_OPERATOR_LOCK_ID}
                     AND pid = pg_backend_pid() AND granted) advisory,
                 (SELECT count(*)::int FROM pg_locks l
                    JOIN pg_class c ON c.oid = l.relation
                   WHERE l.locktype = 'relation'
                     AND l.mode = 'ShareRowExclusiveLock'
                     AND l.pid = pg_backend_pid() AND l.granted
                     AND c.relname IN ('users', 'memberships')) tables
        `,
      );
      assert.deepEqual(
        locks.rows[0],
        { advisory: 1, tables: 2 },
        "Postgres holds the advisory lock and both table locks for this backend",
      );

      const emptyBook: PilotOperatorDependencies = {
        ...onAmbientTransaction,
        findRealOperator: async () => null,
      };
      assert.equal(
        await provisionProductionPilotOperator(env, emptyBook),
        "provisioned",
      );
      assert.deepEqual(await rowsFor(email), {
        users: 1,
        memberships: 1,
        audits: 1,
        claims: 1,
      });

      // The next boot reads the claim through the real isConsumed and stops
      // there: no second identity and no second audit event — even when the
      // retained settings are unusable, because the claim decides, not the
      // environment.
      assert.equal(
        await provisionProductionPilotOperator(env, emptyBook),
        "already-provisioned",
      );
      assert.equal(
        await provisionProductionPilotOperator(
          { ...env, PILOT_OPERATOR_PASSWORD: "short" },
          emptyBook,
        ),
        "already-provisioned",
      );
      assert.deepEqual(await rowsFor(email), {
        users: 1,
        memberships: 1,
        audits: 1,
        claims: 1,
      });
      throw rollback;
    }),
    (error: unknown) => error === rollback,
  );

  // Phase B — a real operator already exists (inserted here, inside the
  // rolled-back transaction): the real findRealOperator finds one, the claim
  // is consumed for a real operator, and the settings create nothing.
  await assert.rejects(
    runInBypassContext(async () => {
      await acquirePilotOperatorLocks();
      const [existing] = await getDb()
        .insert(usersTable)
        .values({
          email: existingEmail,
          fullName: "Existing Operator",
          passwordHash: "unused-in-this-test",
        })
        .returning({ id: usersTable.id });
      assert.ok(existing);
      await getDb().insert(membershipsTable).values({
        userId: existing.id,
        firmId: null,
        role: "operator",
        clientPartyId: null,
        buyerPartyId: null,
      });
      const found = await productionPilotOperatorDependencies.findRealOperator();
      assert.ok(found, "a non-demo operator membership is found");

      assert.equal(
        await provisionProductionPilotOperator(env, onAmbientTransaction),
        "already-provisioned",
      );
      assert.deepEqual(await rowsFor(email), {
        users: 0,
        memberships: 0,
        audits: 0,
        claims: 0,
      });
      const claim = await getDb().execute<{
        email: string;
        operator: number;
        consumed: number;
      }>(sql`
        SELECT u.email,
               (SELECT count(*)::int FROM memberships m
                 WHERE m.user_id = u.id AND m.role = 'operator') operator,
               (SELECT count(*)::int FROM audit_events a
                 WHERE a.entity_id = u.id::text
                   AND a.action = 'operator.bootstrap.consume_existing') consumed
          FROM production_bootstrap_claims c
          JOIN users u ON u.id = c.operator_user_id
         WHERE c.key = 'first-production-operator'
      `);
      const [consumedFor] = claim.rows;
      assert.ok(consumedFor, "the claim now names an operator");
      assert.ok(consumedFor.operator >= 1, "the claimed operator holds an operator membership");
      assert.equal(
        (PRODUCTION_DEMO_EMAILS as readonly string[]).includes(consumedFor.email),
        false,
        "a historical demo identity is never the claimed operator",
      );
      assert.equal(consumedFor.consumed, 1, "one consume_existing audit event");
      throw rollback;
    }),
    (error: unknown) => error === rollback,
  );

  const persisted = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM users WHERE email = ANY($1::text[])) users,
       (SELECT count(*)::int FROM production_bootstrap_claims
         WHERE key = 'first-production-operator') claims`,
    [[email, existingEmail]],
  );
  assert.deepEqual(persisted.rows[0], { users: 0, claims: 0 });
});
