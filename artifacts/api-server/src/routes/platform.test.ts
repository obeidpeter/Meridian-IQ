import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  featureFlagsTable,
  featureFlagOverridesTable,
  firmsTable,
  usersTable,
} from "@workspace/db";
import platformRouter from "./platform.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { crossTenantPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// The activation control plane (R99): a flag's pilot cohort is set and
// cleared with a reason, read back by firm name, and every move lands on
// the audit chain with the actor and the TARGET firm. Clearing hands the
// firm back to the platform default; an explicit `enabled: false` is a
// darkening override, not a clear.

const SALT = makeRunSalt();
const KEY = `pilot_flag_${SALT}`;
const operatorId = randomUUID();
const firmA = randomUUID();
const firmB = randomUUID();
const operator = crossTenantPrincipal("operator", { userId: operatorId });

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: operatorId, email: `op-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Ade & Co ${SALT}` },
    { id: firmB, name: `Bola Partners ${SALT}` },
  ]);
  await db.insert(featureFlagsTable).values({
    key: KEY,
    enabled: false,
    releaseTag: "R2",
    description: "R99 test flag",
  });
});

after(async () => {
  await closeAllServers();
  await getDb()
    .delete(featureFlagOverridesTable)
    .where(eq(featureFlagOverridesTable.flagKey, KEY));
  await getDb().delete(featureFlagsTable).where(eq(featureFlagsTable.key, KEY));
});

async function auditRows(action: string, entityId: string) {
  return getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(eq(auditEventsTable.action, action), eq(auditEventsTable.entityId, entityId)),
    )
    .orderBy(auditEventsTable.seq);
}

test("an override is set with a reason, read back by firm name, counted, and audited", async () => {
  const base = await listen(appFor(operator, platformRouter as express.Router));
  const res = await fetch(`${base}/feature-flags/${KEY}/override`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ firmId: firmA, enabled: true, reason: "Cohort 1 pilot" }),
  });
  assert.equal(res.status, 200);
  const row = (await res.json()) as Record<string, unknown>;
  assert.equal(row.flagKey, KEY);
  assert.equal(row.firmId, firmA);
  assert.equal(row.firmName, `Ade & Co ${SALT}`);
  assert.equal(row.enabled, true);
  assert.equal(row.reason, "Cohort 1 pilot");
  assert.equal(row.setByUserId, operatorId);

  const cohort = (await (
    await fetch(`${base}/feature-flags/${KEY}/overrides`)
  ).json()) as { firmId: string; firmName: string }[];
  assert.deepEqual(cohort.map((c) => c.firmId), [firmA]);

  const flags = (await (await fetch(`${base}/feature-flags`)).json()) as {
    key: string;
    overrideCount: number;
  }[];
  assert.equal(flags.find((f) => f.key === KEY)?.overrideCount, 1);

  const audit = await auditRows("flag.override.set", `${KEY}:${firmA}`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actorId, operatorId);
  assert.equal(audit[0]!.actorRole, "operator");
  assert.equal(audit[0]!.firmId, firmA, "the audit row names the TARGET firm");
  assert.equal(audit[0]!.before, null);
  assert.deepEqual(audit[0]!.after, { enabled: true, reason: "Cohort 1 pilot" });
});

test("re-setting keeps before/after; clearing restores the default and audits; a second clear is a 404", async () => {
  const base = await listen(appFor(operator, platformRouter as express.Router));
  const again = await fetch(`${base}/feature-flags/${KEY}/override`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ firmId: firmA, enabled: false, reason: "Paused: data issue" }),
  });
  assert.equal(again.status, 200);
  const audit = await auditRows("flag.override.set", `${KEY}:${firmA}`);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1]!.before, { enabled: true, reason: "Cohort 1 pilot" });
  assert.deepEqual(audit[1]!.after, { enabled: false, reason: "Paused: data issue" });

  const cleared = await fetch(`${base}/feature-flags/${KEY}/override/${firmA}`, {
    method: "DELETE",
  });
  assert.equal(cleared.status, 204);
  const clearAudit = await auditRows("flag.override.clear", `${KEY}:${firmA}`);
  assert.equal(clearAudit.length, 1);
  assert.equal(clearAudit[0]!.firmId, firmA);
  assert.deepEqual(clearAudit[0]!.before, { enabled: false, reason: "Paused: data issue" });
  assert.equal(clearAudit[0]!.after, null);

  const cohort = (await (
    await fetch(`${base}/feature-flags/${KEY}/overrides`)
  ).json()) as unknown[];
  assert.equal(cohort.length, 0);
  const twice = await fetch(`${base}/feature-flags/${KEY}/override/${firmA}`, {
    method: "DELETE",
  });
  assert.equal(twice.status, 404);
});

test("validation: a reason is required; unknown flag or firm is a 404; the runtime switch is not overridable", async () => {
  const base = await listen(appFor(operator, platformRouter as express.Router));
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  assert.equal((await post(`/feature-flags/${KEY}/override`, { firmId: firmB, enabled: true })).status, 400);
  assert.equal(
    (await post(`/feature-flags/${KEY}/override`, { firmId: firmB, enabled: true, reason: "   " })).status,
    400,
  );
  assert.equal(
    (await post(`/feature-flags/no_such_flag_${SALT}/override`, { firmId: firmB, enabled: true, reason: "why" })).status,
    404,
  );
  assert.equal(
    (await post(`/feature-flags/${KEY}/override`, { firmId: randomUUID(), enabled: true, reason: "why" })).status,
    404,
  );
  assert.equal(
    (await post(`/feature-flags/clerk_ai_runtime/override`, { firmId: firmB, enabled: true, reason: "why" })).status,
    400,
  );
  assert.equal((await fetch(`${base}/feature-flags/no_such_flag_${SALT}/overrides`)).status, 404);
});

test("PATCH flips the platform switch with an audit row; an unseeded key is a 404, never a silent no-op", async () => {
  const base = await listen(appFor(operator, platformRouter as express.Router));
  const flipped = await fetch(`${base}/feature-flags/${KEY}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled: true, reason: "Gate passed" }),
  });
  assert.equal(flipped.status, 204);
  const [flag] = await getDb()
    .select({ enabled: featureFlagsTable.enabled })
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, KEY));
  assert.equal(flag?.enabled, true);
  const audit = await auditRows("flag.update", KEY);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actorId, operatorId);
  assert.deepEqual(audit[0]!.before, { enabled: false });
  assert.deepEqual(audit[0]!.after, { enabled: true, reason: "Gate passed" });

  const missing = await fetch(`${base}/feature-flags/no_such_flag_${SALT}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(missing.status, 404);
});

test("a firm admin reads the cohort but cannot change it", async () => {
  const admin = firmPrincipal(firmA, { role: "firm_admin" });
  const base = await listen(appFor(admin, platformRouter as express.Router));
  assert.equal((await fetch(`${base}/feature-flags/${KEY}/overrides`)).status, 200);
  const denied = await fetch(`${base}/feature-flags/${KEY}/override`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ firmId: firmA, enabled: true, reason: "self-serve" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (await fetch(`${base}/feature-flags/${KEY}/override/${firmA}`, { method: "DELETE" })).status,
    403,
  );
});
