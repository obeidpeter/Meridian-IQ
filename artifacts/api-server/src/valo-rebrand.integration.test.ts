import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  GetMeResponse,
  LoginResponse,
  TotpChallengeResponse,
} from "@workspace/api-zod";
import { z } from "zod";
import {
  closeDatabasePools,
  firmWebhookDeliveriesTable,
  firmWebhooksTable,
  firmsTable,
  getDb,
  membershipsTable,
  partiesTable,
  pool,
  usersTable,
  withTransaction,
} from "@workspace/db";
import {
  authenticate,
  hashPassword,
  PRODUCTION_DEMO_EMAILS,
  SESSION_COOKIE,
  verifySessionToken,
} from "./modules/auth/session.ts";
import { generateTotpSecret, totpCode } from "./modules/auth/totp.ts";
import {
  createFirmWebhook,
  dispatchWebhookDeliveries,
} from "./modules/integrations/webhooks.ts";
import { closeAllServers, listen } from "./test-helpers/route-harness.ts";

// Real main-app authentication and PostgreSQL, with no dev-principal bypass.
// This suite never silently skips an unavailable or unacknowledged database.
const salt = randomUUID();
const userId = randomUUID();
const firmId = randomUUID();
const buyerId = randomUUID();
const email = `valo-rebrand-${salt}@test.local`;
const password = `synthetic-${randomUUID()}`;
const previousNodeEnv = process.env.NODE_ENV;
const previousDevAuth = process.env.ENABLE_DEV_AUTH;
let base: string;

before(async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "Real PostgreSQL DATABASE_URL is required",
  );
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "Set E2E_DATABASE_DISPOSABLE=1 only for a migrated scratch database",
  );
  process.env.NODE_ENV = "test";
  delete process.env.ENABLE_DEV_AUTH;
  await pool.query("SELECT 1");
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: `Valo ${salt}` });
  await getDb()
    .insert(partiesTable)
    .values({
      id: buyerId,
      type: "buyer",
      legalName: `Valo buyer ${salt}`,
    });
  await getDb()
    .insert(usersTable)
    .values({
      id: userId,
      email,
      passwordHash: await hashPassword(password),
    });
  await getDb()
    .insert(membershipsTable)
    .values([
      {
        userId,
        firmId,
        role: "firm_staff",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        userId,
        buyerPartyId: buyerId,
        role: "buyer_user",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);
  const { default: app } = await import("./app.ts");
  base = await listen(app);
});

after(async () => {
  await closeAllServers();
  await closeDatabasePools();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDevAuth === undefined) delete process.env.ENABLE_DEV_AUTH;
  else process.env.ENABLE_DEV_AUTH = previousDevAuth;
});

function post(path: string, body: unknown, headers: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("miq_session="));
  assert.ok(cookie, "The historical miq_session cookie name remains stable");
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; Path=\//i);
  return cookie.split(";")[0];
}

test("both CSRF aliases keep browser login cookie-only and resolve its real principal", async () => {
  assert.equal(SESSION_COOKIE, "miq_session");
  for (const brand of ["valo", "meridian"]) {
    const response = await post(
      "/api/auth/login",
      { email, password },
      { [`x-${brand}-csrf`]: "1" },
    );
    assert.equal(response.status, 200);
    const body = LoginResponse.parse(await response.json());
    assert.equal(body.userId, userId);
    assert.equal(Object.hasOwn(body, "token"), false);
    const cookie = sessionCookie(response);
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(GetMeResponse.parse(await me.json()).userId, userId);
    const blocked = await post("/api/auth/logout", {}, { cookie });
    assert.equal(blocked.status, 403);
    const logout = await post(
      "/api/auth/logout",
      {},
      { cookie, [`x-${brand}-csrf`]: "1" },
    );
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /^miq_session=;/);
  }
});

test("old, new and matching dual mobile headers return the same verifiable bearer as the cookie", async () => {
  const cases = [
    { "x-valo-csrf": "1", "x-valo-client": "mobile" },
    { "x-meridian-csrf": "1", "x-meridian-client": "mobile" },
    {
      "x-valo-csrf": "1",
      "x-meridian-csrf": "1",
      "x-valo-client": "mobile",
      "x-meridian-client": "mobile",
    },
  ];
  for (const headers of cases) {
    const response = await post(
      "/api/auth/login",
      { email, password },
      headers as Record<string, string>,
    );
    assert.equal(response.status, 200);
    const body = LoginResponse.parse(await response.json());
    assert.ok(body.token);
    assert.ok(
      sessionCookie(response) === `miq_session=${body.token}`,
      "Cookie and bearer must match",
    );
    assert.deepEqual(await verifySessionToken(body.token), {
      userId,
      epoch: 0,
    });
    const me = await fetch(`${base}/api/me`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal(GetMeResponse.parse(await me.json()).userId, userId);
  }
});

test("workspace aliases select the buyer membership at login and on subsequent cookie requests", async () => {
  for (const brand of ["valo", "meridian"]) {
    const headers = {
      [`x-${brand}-csrf`]: "1",
      [`x-${brand}-workspace`]: "buyer",
    };
    const login = await post("/api/auth/login", { email, password }, headers);
    assert.equal(login.status, 200);
    const body = LoginResponse.parse(await login.json());
    assert.equal(body.role, "buyer_user");
    assert.equal(body.buyerPartyId, buyerId);
    assert.equal(Object.hasOwn(body, "token"), false);
    const me = await fetch(`${base}/api/me`, {
      headers: {
        cookie: sessionCookie(login),
        [`x-${brand}-workspace`]: "buyer",
      },
    });
    assert.equal(me.status, 200);
    assert.equal(GetMeResponse.parse(await me.json()).role, "buyer_user");
  }
});

test("missing CSRF and conflicting aliases fail closed through the main HTTP stack", async () => {
  const missing = await post(
    "/api/auth/login",
    { email, password },
    { "x-valo-client": "mobile" },
  );
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get("set-cookie"), null);
  for (const name of ["csrf", "client", "workspace"]) {
    const response = await post(
      "/api/auth/login",
      { email, password },
      {
        "x-valo-csrf": "1",
        [`x-valo-${name}`]: name === "client" ? "mobile" : "1",
        [`x-meridian-${name}`]: "conflict",
      },
    );
    assert.equal(response.status, 400, `${name} conflict`);
    assert.ok(
      !response.headers.has("set-cookie"),
      `${name} conflict must not issue a session cookie`,
    );
    assert.equal(
      Object.hasOwn(
        z.record(z.string(), z.unknown()).parse(await response.json()),
        "token",
      ),
      false,
    );
  }
});

test("browser and both mobile aliases withhold sessions until a real TOTP challenge succeeds", async () => {
  for (const brand of [null, "valo", "meridian"]) {
    const id = randomUUID();
    const mfaEmail = `valo-mfa-${id}@test.local`;
    const secret = generateTotpSecret();
    await getDb()
      .insert(usersTable)
      .values({
        id,
        email: mfaEmail,
        passwordHash: await hashPassword(password),
        totpSecret: secret,
        totpEnabledAt: new Date(),
      });
    await getDb()
      .insert(membershipsTable)
      .values({ userId: id, firmId, role: "firm_staff" });
    const headers: Record<string, string> = { "x-valo-csrf": "1" };
    if (brand) headers[`x-${brand}-client`] = "mobile";
    const login = await post(
      "/api/auth/login",
      { email: mfaEmail, password },
      headers,
    );
    assert.equal(login.status, 200);
    const pending = LoginResponse.parse(await login.json());
    assert.equal(pending.mfaRequired, true);
    assert.ok(pending.mfaToken);
    assert.equal(Object.hasOwn(pending, "token"), false);
    assert.equal(login.headers.get("set-cookie"), null);
    const challengeBody = {
      mfaToken: pending.mfaToken,
      code: totpCode(secret, Date.now()),
    };
    const challenge = await post(
      "/api/auth/totp/challenge",
      challengeBody,
      headers,
    );
    assert.equal(challenge.status, 200);
    const signedIn = TotpChallengeResponse.parse(await challenge.json());
    const cookie = sessionCookie(challenge);
    if (brand) {
      assert.ok(signedIn.token);
      assert.ok(
        cookie === `miq_session=${signedIn.token}`,
        "Cookie and bearer must match",
      );
      assert.deepEqual(await verifySessionToken(signedIn.token), {
        userId: id,
        epoch: 0,
      });
    } else {
      assert.equal(Object.hasOwn(signedIn, "token"), false);
    }
    const replay = await post(
      "/api/auth/totp/challenge",
      challengeBody,
      headers,
    );
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get("set-cookie"), null);
  }
});

test("copied legacy and Valo demo credentials cannot authenticate in production", async () => {
  const expectedValo = [
    "demo.staff@valo.example",
    "demo.admin@valo.example",
    "ops@valo.example",
    "audit@valo.example",
    "claims.approver@valo.example",
  ];
  for (const demo of expectedValo)
    assert.ok(
      PRODUCTION_DEMO_EMAILS.includes(
        demo as (typeof PRODUCTION_DEMO_EMAILS)[number],
      ),
    );
  const rollback = new Error("rollback-only demo credential fixture");
  const previous = process.env.NODE_ENV;
  try {
    await assert.rejects(
      withTransaction(async () => {
        const passwordHash = await hashPassword(password);
        await getDb()
          .insert(usersTable)
          .values(
            PRODUCTION_DEMO_EMAILS.map((demo) => ({
              id: randomUUID(),
              email: demo,
              passwordHash,
            })),
          )
          .onConflictDoUpdate({
            target: usersTable.email,
            set: { passwordHash },
          });
        process.env.NODE_ENV = "test";
        for (const demo of PRODUCTION_DEMO_EMAILS) {
          assert.ok(
            await authenticate(demo, password),
            "Fixture credentials must work before the production guard",
          );
        }
        process.env.NODE_ENV = "production";
        assert.ok(
          await authenticate(email, password),
          "The production guard must not reject an ordinary account",
        );
        for (const demo of PRODUCTION_DEMO_EMAILS) {
          assert.equal(await authenticate(demo, password), null, demo);
          assert.equal(
            await authenticate(`  ${demo.toUpperCase()}  `, password),
            null,
            "Normalization must not bypass the denylist",
          );
        }
        throw rollback;
      }),
      (error: unknown) => error === rollback,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("one real webhook delivery carries identical Valo and legacy signatures over the exact body", async () => {
  const captured: Array<{ body: Buffer; headers: Record<string, unknown> }> =
    [];
  const receiver = express();
  receiver.post(
    "/hook",
    express.raw({ type: "application/json" }),
    (req, res) => {
      captured.push({ body: req.body, headers: req.headers });
      res.sendStatus(204);
    },
  );
  const receiverBase = await listen(receiver);
  const hook = await createFirmWebhook(firmId, `${receiverBase}/hook`, [
    "invoice.stamped",
  ]);
  try {
    const [delivery] = await getDb()
      .insert(firmWebhookDeliveriesTable)
      .values({
        webhookId: hook.row.id,
        firmId,
        eventType: "invoice.stamped",
        eventKey: `valo-rebrand:${salt}`,
        payload: { entityType: "invoice", entityId: randomUUID() },
      })
      .returning();
    await dispatchWebhookDeliveries();
    assert.equal(captured.length, 1);
    const [{ body, headers }] = captured;
    const key = createHash("sha256").update(hook.secret).digest("hex");
    const expected = createHmac("sha256", key).update(body).digest("hex");
    assert.equal(headers["x-valo-signature"], expected);
    assert.equal(headers["x-meridian-signature"], expected);
    assert.equal(headers["x-valo-event"], "invoice.stamped");
    assert.equal(headers["x-meridian-event"], "invoice.stamped");
    const payload = JSON.parse(body.toString("utf8"));
    assert.deepEqual(Object.keys(payload).sort(), [
      "createdAt",
      "entityId",
      "entityType",
      "eventType",
      "id",
    ]);
    assert.equal(payload.id, delivery.id);
    const [stored] = await getDb()
      .select()
      .from(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
    assert.equal(stored.status, "delivered");
    assert.equal(stored.attempts, 1);
  } finally {
    await getDb()
      .delete(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.webhookId, hook.row.id));
    await getDb()
      .delete(firmWebhooksTable)
      .where(eq(firmWebhooksTable.id, hook.row.id));
  }
});
