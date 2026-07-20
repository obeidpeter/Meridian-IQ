import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
  billingTiersTable,
  firmSubscriptionsTable,
  paymentIntentsTable,
  auditEventsTable,
} from "@workspace/db";
import billingPaymentsRouter from "../../routes/billing-payments.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { lagosMonthStart } from "../clerk/client-statement.ts";
import { resetPaymentProvider } from "./provider.ts";

// Payment collection seam. Pinned invariants:
//  - the amount is NEVER a caller input: it comes from the billing-statement
//    fee core (base + overage on the firm's tier), frozen onto the intent;
//  - closed-month discipline (open month 400), zero-fee months refuse (400),
//    and the one-live-intent index makes a duplicate a 409 — pending AND
//    confirmed block, failed frees the slot;
//  - provider seam: the simulator answers when no relay is configured
//    (dark by default); PAYMENT_PROVIDER_URL lights a generic JSON relay
//    whose checkoutUrl lands on the intent, and a broken relay creates
//    NOTHING (fail closed, 502);
//  - confirmation webhook: fail-closed PAYMENT_WEBHOOK_TOKEN (unset = 404),
//    CAS pending→confirmed/failed with confirmedAt stamped on confirm,
//    202 for replays and unknown refs alike (idempotent, no ref oracle),
//    pointer-only audit exactly once per settle;
//  - RLS: firm-keyed policy (migration 0021) holds behaviorally.

const SALT = makeRunSalt();

const firmPay = randomUUID(); // enterprise_lite, 3 accepted invoices in MONTH
const firmFree = randomUUID(); // compliance_desk pinned to a zero fee
const supplier = randomUUID();
const buyer = randomUUID();

const MONTH = lagosMonthStart(1); // newest closed Lagos month
const M2 = lagosMonthStart(2);
const M3 = lagosMonthStart(3);
const M4 = lagosMonthStart(4);
const OPEN = lagosMonthStart(0);
const inMonthUtc = new Date(`${MONTH.slice(0, 8)}10T12:00:00.000Z`);

// Tier config is global reference data keyed by the enum. This file pins the
// two keys the billing-statement tests leave alone (test files run with
// --test-concurrency=1, so per-file pins never race).
const TIER = {
  enterprise_lite: {
    name: `Ent Lite ${SALT}`,
    monthlyPrice: "20000",
    includedInvoices: 1,
    overagePrice: "300",
    revenueSharePct: "0.2",
    clerkMonthlyTokens: null as number | null,
  },
  compliance_desk: {
    name: `Desk Zero ${SALT}`,
    monthlyPrice: "0",
    includedInvoices: 1000,
    overagePrice: "0",
    revenueSharePct: "0.2",
    clerkMonthlyTokens: null as number | null,
  },
};

// Fee for firmPay in MONTH: base 20000 + (3 accepted − 1 included) × 300.
const MONTH_FEE = "20600.00";
// Months with no accepted invoices still owe the base subscription.
const BASE_FEE = "20000.00";

const admin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmPay,
  clientPartyId: null,
  buyerPartyId: null,
};
const adminFree: Principal = {
  ...admin,
  userId: randomUUID(),
  firmId: firmFree,
};
const client: Principal = {
  ...admin,
  userId: randomUUID(),
  role: "client_user",
  clientPartyId: supplier,
};
const operator: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

const WEBHOOK_TOKEN = `pay-hook-${SALT}`;

let asAdmin: string;
let asAdminFree: string;
let asClient: string;
let asOperator: string;

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

interface IntentView {
  id: string;
  monthStart: string;
  amountNgn: string;
  status: string;
  providerRef: string | null;
  checkoutUrl: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmPay, name: `Pay Firm ${SALT}` },
    { id: firmFree, name: `Free Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: supplier, type: "client_business", legalName: `Pay Supplier ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Pay Buyer ${SALT}` },
  ]);
  for (const [key, cfg] of Object.entries(TIER)) {
    await db
      .insert(billingTiersTable)
      .values({ key: key as never, ...cfg })
      .onConflictDoUpdate({ target: billingTiersTable.key, set: { ...cfg } });
  }
  const tierId = async (key: string) =>
    (
      await db
        .select({ id: billingTiersTable.id })
        .from(billingTiersTable)
        .where(eq(billingTiersTable.key, key as never))
    )[0].id;
  await db.insert(firmSubscriptionsTable).values([
    { firmId: firmPay, tierId: await tierId("enterprise_lite") },
    { firmId: firmFree, tierId: await tierId("compliance_desk") },
  ]);

  // Three accepted invoices in MONTH (the billing statement's vat-pack
  // predicate: Lagos issue month + an accepted attempt).
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId: firmPay,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: `PAY-${i}-${SALT}`,
      kind: "invoice",
      issueDate: `${MONTH.slice(0, 8)}05`,
      status: "stamped",
    });
    await db.insert(submissionAttemptsTable).values({
      invoiceId: id,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `pay-${id}`,
      status: "accepted",
      createdAt: inMonthUtc,
    });
  }

  asAdmin = await listen(appFor(admin, billingPaymentsRouter));
  asAdminFree = await listen(appFor(adminFree, billingPaymentsRouter));
  asClient = await listen(appFor(client, billingPaymentsRouter));
  asOperator = await listen(appFor(operator, billingPaymentsRouter));
});

after(async () => {
  delete process.env.PAYMENT_WEBHOOK_TOKEN;
  delete process.env.PAYMENT_PROVIDER_URL;
  delete process.env.PAYMENT_PROVIDER_TOKEN;
  resetPaymentProvider();
  await closeAllServers();
});

// Captured across tests (node:test runs a file's tests in order).
let intentA: IntentView;

test("create: amount from the billing-statement fee core; simulator provider shape", async () => {
  const resp = await post(asAdmin, "/billing/payments", { monthStart: MONTH });
  assert.equal(resp.status, 201);
  intentA = (await resp.json()) as IntentView;
  assert.equal(intentA.monthStart, MONTH);
  assert.equal(intentA.amountNgn, MONTH_FEE);
  assert.equal(intentA.status, "pending");
  assert.ok(
    intentA.providerRef?.startsWith("sim_"),
    "simulator mints the reference when no relay is configured",
  );
  assert.equal(intentA.checkoutUrl, null);
  assert.equal(intentA.confirmedAt, null);
  // firmId never leaves the server (the contract has no such field).
  assert.ok(!("firmId" in (intentA as unknown as Record<string, unknown>)));

  // Pointer-only creation audit.
  const audits = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "payment_intent"),
        eq(auditEventsTable.entityId, intentA.id),
      ),
    );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "billing.payment_intent.created");
  assert.deepEqual(audits[0].after, { status: "pending", monthStart: MONTH });
});

test("closed-month discipline and the zero-fee refusal", async () => {
  // The open month is refused; so is a well-formed month off the list and
  // outright garbage (contract regex).
  assert.equal(
    (await post(asAdmin, "/billing/payments", { monthStart: OPEN })).status,
    400,
  );
  assert.equal(
    (await post(asAdmin, "/billing/payments", { monthStart: "2019-01-01" }))
      .status,
    400,
  );
  assert.equal(
    (await post(asAdmin, "/billing/payments", { monthStart: "never" })).status,
    400,
  );
  // A zero-fee month has nothing to collect.
  const zero = await post(asAdminFree, "/billing/payments", {
    monthStart: MONTH,
  });
  assert.equal(zero.status, 400);
  assert.match(((await zero.json()) as { error: string }).error, /fee/i);
});

test("gates: the billing-statement audience exactly", async () => {
  // client_user holds no console.portfolio.read; an operator has no firm to
  // pay for.
  assert.equal(
    (await post(asClient, "/billing/payments", { monthStart: MONTH })).status,
    403,
  );
  assert.equal((await fetch(`${asClient}/billing/payments`)).status, 403);
  assert.equal(
    (await post(asOperator, "/billing/payments", { monthStart: MONTH })).status,
    403,
  );
  assert.equal((await fetch(`${asOperator}/billing/payments`)).status, 403);
});

test("duplicate live intent: pending and confirmed block, failed frees the slot", async () => {
  process.env.PAYMENT_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    // Pending blocks.
    assert.equal(
      (await post(asAdmin, "/billing/payments", { monthStart: MONTH })).status,
      409,
    );
    // Confirm intent A; confirmed still blocks.
    const confirm = await post(
      asAdmin,
      "/billing/payments/confirm",
      { providerRef: intentA.providerRef, outcome: "confirmed" },
      { "x-op-token": WEBHOOK_TOKEN },
    );
    assert.equal(confirm.status, 202);
    assert.equal(
      (await post(asAdmin, "/billing/payments", { monthStart: MONTH })).status,
      409,
    );

    // A failed attempt frees its month for a retry.
    const b = await post(asAdmin, "/billing/payments", { monthStart: M2 });
    assert.equal(b.status, 201);
    const intentB = (await b.json()) as IntentView;
    assert.equal(intentB.amountNgn, BASE_FEE);
    assert.equal(
      (
        await post(
          asAdmin,
          "/billing/payments/confirm",
          { providerRef: intentB.providerRef, outcome: "failed" },
          { "x-op-token": WEBHOOK_TOKEN },
        )
      ).status,
      202,
    );
    const retry = await post(asAdmin, "/billing/payments", { monthStart: M2 });
    assert.equal(retry.status, 201);

    // The failed intent kept confirmedAt null; the confirmed one is stamped.
    const list = (await (
      await fetch(`${asAdmin}/billing/payments`)
    ).json()) as IntentView[];
    const a = list.find((i) => i.id === intentA.id);
    const failedB = list.find((i) => i.id === intentB.id);
    assert.equal(a?.status, "confirmed");
    assert.ok(a?.confirmedAt, "confirm stamps confirmedAt");
    assert.equal(failedB?.status, "failed");
    assert.equal(failedB?.confirmedAt, null);
  } finally {
    delete process.env.PAYMENT_WEBHOOK_TOKEN;
  }
});

test("list: the firm's intents newest-first, never a neighbour's", async () => {
  const list = (await (
    await fetch(`${asAdmin}/billing/payments`)
  ).json()) as IntentView[];
  assert.ok(list.length >= 3);
  for (let i = 1; i < list.length; i++) {
    assert.ok(
      new Date(list[i - 1].createdAt).getTime() >=
        new Date(list[i].createdAt).getTime(),
      "newest first",
    );
  }
  const other = (await (
    await fetch(`${asAdminFree}/billing/payments`)
  ).json()) as IntentView[];
  assert.deepEqual(
    other.filter((i) => list.some((l) => l.id === i.id)),
    [],
    "another firm's list never carries these intents",
  );
});

test("webhook: dark without the secret (404), wrong token 401, bad body 400", async () => {
  delete process.env.PAYMENT_WEBHOOK_TOKEN;
  assert.equal(
    (
      await post(asAdmin, "/billing/payments/confirm", {
        providerRef: "sim_x",
        outcome: "confirmed",
      })
    ).status,
    404,
  );
  process.env.PAYMENT_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    assert.equal(
      (
        await post(
          asAdmin,
          "/billing/payments/confirm",
          { providerRef: "sim_x", outcome: "confirmed" },
          { "x-op-token": "wrong" },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await post(
          asAdmin,
          "/billing/payments/confirm",
          { providerRef: "", outcome: "paid" },
          { "x-op-token": WEBHOOK_TOKEN },
        )
      ).status,
      400,
    );
  } finally {
    delete process.env.PAYMENT_WEBHOOK_TOKEN;
  }
});

test("webhook: replayed and unknown confirmations are 202 no-ops (single audit)", async () => {
  process.env.PAYMENT_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  try {
    const [before] = await getDb()
      .select()
      .from(paymentIntentsTable)
      .where(eq(paymentIntentsTable.id, intentA.id));
    // Replay the already-settled confirmation — even flipping the outcome
    // changes nothing (CAS matches pending only).
    for (const outcome of ["confirmed", "failed"] as const) {
      assert.equal(
        (
          await post(
            asAdmin,
            "/billing/payments/confirm",
            { providerRef: intentA.providerRef, outcome },
            { "x-op-token": WEBHOOK_TOKEN },
          )
        ).status,
        202,
      );
    }
    const [afterRow] = await getDb()
      .select()
      .from(paymentIntentsTable)
      .where(eq(paymentIntentsTable.id, intentA.id));
    assert.equal(afterRow.status, "confirmed");
    assert.equal(
      afterRow.confirmedAt?.toISOString(),
      before.confirmedAt?.toISOString(),
      "a replay never restamps confirmedAt",
    );
    const settleAudits = await getDb()
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, intentA.id),
          eq(auditEventsTable.action, "billing.payment_intent.confirmed"),
        ),
      );
    assert.equal(settleAudits.length, 1, "exactly one settle audit");
    assert.deepEqual(settleAudits[0].after, {
      status: "confirmed",
      monthStart: MONTH,
    });

    // A reference that never existed looks identical to a replay.
    assert.equal(
      (
        await post(
          asAdmin,
          "/billing/payments/confirm",
          { providerRef: `ghost_${SALT}`, outcome: "confirmed" },
          { "x-op-token": WEBHOOK_TOKEN },
        )
      ).status,
      202,
    );
  } finally {
    delete process.env.PAYMENT_WEBHOOK_TOKEN;
  }
});

test("relay-lit provider: generic JSON shape in, checkoutUrl out; a broken relay creates nothing", async () => {
  const seen: { body: Record<string, unknown>; token: string | undefined }[] =
    [];
  let mode: "ok" | "fail" = "ok";
  const relay = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >,
        token: req.headers["x-op-token"] as string | undefined,
      });
      if (mode === "fail") {
        res.statusCode = 500;
        res.end("relay down");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          providerRef: `psk_${SALT}`,
          checkoutUrl: `https://checkout.test/${SALT}`,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const { port } = relay.address() as AddressInfo;
  process.env.PAYMENT_PROVIDER_URL = `http://127.0.0.1:${port}/init`;
  process.env.PAYMENT_PROVIDER_TOKEN = `relay-${SALT}`;
  try {
    const resp = await post(asAdmin, "/billing/payments", { monthStart: M3 });
    assert.equal(resp.status, 201);
    const intent = (await resp.json()) as IntentView;
    assert.equal(intent.providerRef, `psk_${SALT}`);
    assert.equal(intent.checkoutUrl, `https://checkout.test/${SALT}`);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].body, {
      kind: "payment_init",
      firmId: firmPay,
      monthStart: M3,
      amountNgn: BASE_FEE,
    });
    assert.equal(seen[0].token, `relay-${SALT}`);

    // A relay that answers 500 fails the request closed: 502, no intent.
    mode = "fail";
    assert.equal(
      (await post(asAdmin, "/billing/payments", { monthStart: M4 })).status,
      502,
    );
    const list = (await (
      await fetch(`${asAdmin}/billing/payments`)
    ).json()) as IntentView[];
    assert.ok(
      !list.some((i) => i.monthStart === M4),
      "no intent row survives a failed provider init",
    );
  } finally {
    delete process.env.PAYMENT_PROVIDER_URL;
    delete process.env.PAYMENT_PROVIDER_TOKEN;
    await new Promise<void>((resolve, reject) =>
      relay.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("RLS: payment_intents is firm-keyed (migration 0021)", async () => {
  // Real posture: meridian_app role + firm GUC, exactly what tenantContext
  // binds for a firm principal. firmFree must see none of firmPay's intents
  // and must not write into firmPay's tenant.
  const visible = await runRequestContext(
    { bypass: false, firmId: firmFree },
    () =>
      getDb()
        .select({ id: paymentIntentsTable.id })
        .from(paymentIntentsTable)
        .where(eq(paymentIntentsTable.firmId, firmPay)),
  );
  assert.deepEqual(visible, []);
  await assert.rejects(
    runRequestContext({ bypass: false, firmId: firmFree }, () =>
      getDb()
        .insert(paymentIntentsTable)
        .values({
          firmId: firmPay,
          monthStart: M4,
          amountNgn: "1.00",
          status: "pending",
        })
        .returning(),
    ),
    "cross-firm insert must violate the policy",
  );
});
