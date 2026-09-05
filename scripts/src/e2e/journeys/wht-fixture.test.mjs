import assert from "node:assert/strict";
import test from "node:test";
import { seedIncomingWhtBill } from "./wht-fixture.mjs";

const input = {
  sourceBillId: "b1112001-0000-4000-8000-000000002001",
  clientPartyId: "22222222-2222-4222-8222-222222222222",
  period: "2026-08",
};
const env = {
  DATABASE_URL: "postgresql://localhost/disposable_e2e_fixture",
  E2E_DATABASE_DISPOSABLE: "1",
  NODE_ENV: "test",
};
const invoiceId = "12345678-1234-4567-89ab-123456789abc";

function fixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    env,
    newId: () => invoiceId,
    query: (...args) => calls.push(args),
    ...overrides,
  };
  return {
    calls,
    seed: (values = input) => seedIncomingWhtBill(values, dependencies),
  };
}

for (const [name, unsafeEnv] of [
  ["missing guard", { ...env, E2E_DATABASE_DISPOSABLE: undefined }],
  [
    "truthy but non-explicit guard",
    { ...env, E2E_DATABASE_DISPOSABLE: "true" },
  ],
  ["missing URL", { ...env, DATABASE_URL: undefined }],
  ["blank URL", { ...env, DATABASE_URL: " " }],
  ["production", { ...env, NODE_ENV: "production" }],
]) {
  test(`WHT fixture rejects ${name} before issuing SQL`, () => {
    const { seed, calls } = fixture({ env: unsafeEnv });
    assert.throws(() => seed(), /scratch|DISPOSABLE|production/);
    assert.equal(calls.length, 0);
  });
}

for (const [key, value] of [
  ["sourceBillId", undefined],
  ["sourceBillId", "not-a-uuid"],
  [
    "clientPartyId",
    "22222222-2222-4222-8222-222222222222'; DELETE FROM invoices;--",
  ],
  ["period", "2026-00"],
  ["period", "2026-13"],
  ["period", "2026-8"],
  ["period", "0000-01"],
  ["period", "2026-08'; COMMIT;--"],
]) {
  test(`WHT fixture rejects invalid ${key}: ${value}`, () => {
    const { seed, calls } = fixture();
    assert.throws(() => seed({ ...input, [key]: value }), /UUID|YYYY-MM/);
    assert.equal(calls.length, 0);
  });
}

test("WHT fixture validates generated identifiers before interpolation", () => {
  const { seed, calls } = fixture({ newId: () => "bad';--" });
  assert.throws(() => seed(), /UUID/);
  assert.equal(calls.length, 0);
});

test("WHT fixture inserts one uncategorized bill and line atomically in the original buyer's firm", () => {
  const { seed, calls } = fixture();
  assert.deepEqual(seed(), { invoiceId, invoiceNumber: `WHT-${invoiceId}` });
  assert.equal(calls.length, 1);
  const [url, sql] = calls[0];
  assert.equal(url, env.DATABASE_URL);
  assert.match(sql, /^BEGIN;\s+SET LOCAL app\.bypass = 'on';/);
  assert.match(sql, /COMMIT;$/);
  assert.match(sql, /DO \$wht_fixture\$/);
  assert.match(sql, /GET DIAGNOSTICS inserted_count = ROW_COUNT;/);
  assert.match(sql, /IF inserted_count <> 1 THEN\s+RAISE EXCEPTION/);
  assert.match(
    sql,
    /source\.firm_id, source\.supplier_party_id,\s+source\.buyer_party_id/,
  );
  assert.ok(sql.includes(`source.id = '${input.sourceBillId}'::uuid`));
  assert.ok(
    sql.includes(`source.buyer_party_id = '${input.clientPartyId}'::uuid`),
  );
  assert.match(sql, /source\.invoice_number = 'BILL-2001'/);
  assert.match(
    sql,
    /e\.client_party_id = source\.buyer_party_id AND e\.status <> 'archived'/,
  );
  assert.match(
    sql,
    /AND NOT EXISTS \(\s+SELECT 1 FROM engagements e WHERE e\.firm_id = source\.firm_id\s+AND e\.client_party_id = source\.supplier_party_id\s+\)/,
  );
  assert.match(sql, /'2026-08-15'::date, 'draft', NULL, 200000, 15000, 215000/);
  assert.equal((sql.match(/INSERT INTO invoices\s/g) ?? []).length, 1);
  assert.equal((sql.match(/INSERT INTO invoice_lines\s/g) ?? []).length, 1);
  assert.ok(
    sql.includes(`'${invoiceId}'::uuid, 1, 'WHT probe professional services'`),
  );
  assert.match(sql, /1, 200000, 0\.075, 200000, 15000/);
  assert.doesNotMatch(
    sql,
    /services_5|INSERT INTO (parties|engagements)|ALTER |CREATE POLICY|UPDATE |DELETE /,
  );
});

test("WHT fixture never returns a successful result when the atomic query fails", () => {
  const failure = new Error("source absent or line insert rejected");
  const { seed } = fixture({
    query: () => {
      throw failure;
    },
  });
  assert.throws(
    () => seed(),
    (error) => error === failure,
  );
});

test("WHT fixture default UUIDs keep repeated runs independent", () => {
  const calls = [];
  const dependencies = { env, query: (...args) => calls.push(args) };
  const first = seedIncomingWhtBill(input, dependencies);
  const second = seedIncomingWhtBill(input, dependencies);
  assert.notEqual(first.invoiceId, second.invoiceId);
  assert.notEqual(first.invoiceNumber, second.invoiceNumber);
  assert.equal(calls.length, 2);
  assert.ok(calls[0][1].includes(first.invoiceNumber));
  assert.ok(calls[1][1].includes(second.invoiceNumber));
});
