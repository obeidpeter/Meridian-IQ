import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import pushRouter from "./push.ts";
import { errorHandler } from "../middleware/error.ts";
import type { Principal } from "../modules/auth/rbac.ts";

// Capability scoping for the mobile push-device registry (SEC): the routes are
// part of the SME family and must reject roles that lack "invoice.read"
// (bank_user, buyer_user) with 403 BEFORE touching the database, while SME
// roles pass the gate. Principals with a non-UUID userId (the dev shim's
// "dev-user") exercise the allowed path without requiring DB rows.

function appFor(principal: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = principal;
    req.log = {
      warn: () => {},
      error: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use(pushRouter);
  app.use(errorHandler);
  return app;
}

function principalFor(role: Principal["role"]): Principal {
  return {
    userId: "dev-user",
    role,
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
}

async function listen(app: express.Express): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(closers.map((c) => c()));
});

const DENIED_ROLES: Principal["role"][] = ["bank_user", "buyer_user"];

for (const role of DENIED_ROLES) {
  test(`push device routes reject ${role} (lacks invoice.read) with 403`, async () => {
    const { base, close } = await listen(appFor(principalFor(role)));
    closers.push(close);

    const listRes = await fetch(`${base}/push/devices`);
    assert.equal(listRes.status, 403, "list must be capability-gated");

    const registerRes = await fetch(`${base}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expoPushToken: "ExponentPushToken[test]",
        platform: "android",
      }),
    });
    assert.equal(registerRes.status, 403, "register must be capability-gated");

    const unregisterRes = await fetch(`${base}/push/devices/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expoPushToken: "ExponentPushToken[test]" }),
    });
    assert.equal(
      unregisterRes.status,
      403,
      "unregister must be capability-gated",
    );
  });
}

const ALLOWED_ROLES: Principal["role"][] = [
  "firm_admin",
  "firm_staff",
  "client_user",
];

for (const role of ALLOWED_ROLES) {
  test(`push device routes admit ${role} past the capability gate`, async () => {
    const { base, close } = await listen(appFor(principalFor(role)));
    closers.push(close);

    // Non-UUID dev userId: list short-circuits to [] without touching the DB —
    // a 200 here proves the capability gate passed for the SME role.
    const listRes = await fetch(`${base}/push/devices`);
    assert.equal(listRes.status, 200);
    assert.deepEqual(await listRes.json(), []);

    // Register rejects the non-UUID principal with 400 (not 403): past the
    // capability gate, failing only the real-session ownership guard.
    const registerRes = await fetch(`${base}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expoPushToken: "ExponentPushToken[test]",
        platform: "android",
      }),
    });
    assert.equal(registerRes.status, 400);

    // Unregister is idempotent and returns 204 without a DB row to delete.
    const unregisterRes = await fetch(`${base}/push/devices/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expoPushToken: "ExponentPushToken[test]" }),
    });
    assert.equal(unregisterRes.status, 204);
  });
}
