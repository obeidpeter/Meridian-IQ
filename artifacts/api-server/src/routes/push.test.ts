import { test, after } from "node:test";
import assert from "node:assert/strict";
import pushRouter from "./push.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";

// Capability scoping for the mobile push-device registry (SEC): the routes are
// part of the SME family and must reject roles that lack "invoice.read"
// (bank_user, buyer_user) with 403 BEFORE touching the database, while SME
// roles pass the gate. Principals with a non-UUID userId (the dev shim's
// "dev-user") exercise the allowed path without requiring DB rows.

function principalFor(role: Principal["role"]): Principal {
  return {
    userId: "dev-user",
    role,
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
}

after(async () => {
  await closeAllServers();
});

const DENIED_ROLES: Principal["role"][] = ["bank_user", "buyer_user"];

for (const role of DENIED_ROLES) {
  test(`push device routes reject ${role} (lacks invoice.read) with 403`, async () => {
    const base = await listen(appFor(principalFor(role), pushRouter));

    const listRes = await fetch(`${base}/sme/push/devices`);
    assert.equal(listRes.status, 403, "list must be capability-gated");

    const registerRes = await fetch(`${base}/sme/push/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        expoPushToken: "ExponentPushToken[test]",
        platform: "android",
      }),
    });
    assert.equal(registerRes.status, 403, "register must be capability-gated");

    const unregisterRes = await fetch(`${base}/sme/push/devices/unregister`, {
      method: "POST",
      headers: JSON_HEADERS,
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
    const base = await listen(appFor(principalFor(role), pushRouter));

    // Non-UUID dev userId: list short-circuits to [] without touching the DB —
    // a 200 here proves the capability gate passed for the SME role.
    const listRes = await fetch(`${base}/sme/push/devices`);
    assert.equal(listRes.status, 200);
    assert.deepEqual(await listRes.json(), []);

    // Register rejects the non-UUID principal with 400 (not 403): past the
    // capability gate, failing only the real-session ownership guard.
    const registerRes = await fetch(`${base}/sme/push/devices`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        expoPushToken: "ExponentPushToken[test]",
        platform: "android",
      }),
    });
    assert.equal(registerRes.status, 400);

    // Unregister is idempotent and returns 204 without a DB row to delete.
    const unregisterRes = await fetch(`${base}/sme/push/devices/unregister`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ expoPushToken: "ExponentPushToken[test]" }),
    });
    assert.equal(unregisterRes.status, 204);
  });
}
