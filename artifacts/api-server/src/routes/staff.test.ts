import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  usersTable,
  staffNotificationPreferencesTable,
} from "@workspace/db";
import staffRouter from "./staff.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { clearActionFailures } from "../modules/auth/throttle.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Staff notification preferences: self-service on the caller's OWN row for
// the CURRENT firm — the key is (userId, firmId), both from the principal —
// opt-in defaults (everything off), firm members only. The role gate is
// explicit — firm_admin/firm_staff — because this is not a capability-matrix
// surface: nothing here touches anyone else's data.
//
// Email verification (round 15): the saved address only lights the digest
// email channel once verified — code dispatched through the outbound relay
// (the deliberate SEC-12 exception), sha256-only stored, 15-minute expiry,
// and any address change drops the verification.

const SALT = makeRunSalt();
const firmId = randomUUID();
const firm2Id = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const verifyId = randomUUID();

type PrefsBody = {
  digestEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  email: string | null;
  emailVerifiedAt: string | null;
};

function principalFor(
  role: Principal["role"],
  userId: string,
  firm: string = firmId,
): Principal {
  return {
    userId,
    role,
    firmId: firm,
    clientPartyId: role === "client_user" ? randomUUID() : null,
    buyerPartyId: null,
  };
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Staff Prefs Firm ${SALT}` },
    { id: firm2Id, name: `Staff Prefs Firm B ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: adminId, email: `staff-prefs-admin-${SALT}@test.example` },
    { id: staffId, email: `staff-prefs-staff-${SALT}@test.example` },
    { id: verifyId, email: `staff-prefs-verify-${SALT}@test.example` },
  ]);
});

after(async () => {
  await closeAllServers();
  delete process.env.MESSAGING_WEBHOOK_URL;
  delete process.env.MESSAGING_WEBHOOK_TOKEN;
  await clearActionFailures(`everify:${verifyId}`);
  await clearActionFailures(`everifyc:${verifyId}`);
  const db = getDb();
  await db
    .delete(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.firmId, firmId));
  await db
    .delete(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.firmId, firm2Id));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, verifyId));
  await db.delete(firmsTable).where(eq(firmsTable.id, firmId));
  await db.delete(firmsTable).where(eq(firmsTable.id, firm2Id));
});

async function verifyRow(userId: string) {
  const [row] = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, userId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    )
    .limit(1);
  return row;
}

test("GET returns the all-off defaults for a member who never saved", async () => {
  const base = await listen(appFor(principalFor("firm_admin", adminId), staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`);
  assert.equal(res.status, 200);
  const prefs = (await res.json()) as PrefsBody;
  assert.deepEqual(prefs, {
    digestEnabled: false,
    emailEnabled: false,
    pushEnabled: false,
    email: null,
    emailVerifiedAt: null,
  });
});

test("PUT upserts the caller's own row and partial input merges", async () => {
  const base = await listen(appFor(principalFor("firm_staff", staffId), staffRouter));

  // First save: opt in to the digest by email.
  const first = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: true,
      email: `me-${SALT}@test.example`,
    }),
  });
  assert.equal(first.status, 200);
  const saved = (await first.json()) as PrefsBody;
  assert.deepEqual(saved, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: false, // untouched switch keeps its default
    email: `me-${SALT}@test.example`,
    emailVerifiedAt: null,
  });

  // Partial update: only pushEnabled — everything else must survive.
  const second = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ pushEnabled: true }),
  });
  assert.equal(second.status, 200);
  const merged = (await second.json()) as PrefsBody;
  assert.deepEqual(merged, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: true,
    email: `me-${SALT}@test.example`,
    emailVerifiedAt: null,
  });

  // GET reads the saved state back.
  const read = await fetch(`${base}/staff/notification-preferences`);
  assert.deepEqual((await read.json()) as PrefsBody, merged);

  // Explicit null clears the address; omitted email would have kept it.
  const cleared = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as PrefsBody).email, null);

  // One row, pinned to the principal (userId never comes from input).
  const rows = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.userId, staffId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firmId, firmId);
});

test("a malformed email is rejected with 400", async () => {
  const base = await listen(appFor(principalFor("firm_admin", adminId), staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: "not-an-address" }),
  });
  assert.equal(res.status, 400);
});

test("client_user (and other non-staff roles) are rejected with 403", async () => {
  for (const role of ["client_user", "operator", "buyer_user"] as const) {
    const base = await listen(appFor(principalFor(role, randomUUID()), staffRouter));
    const get = await fetch(`${base}/staff/notification-preferences`);
    assert.equal(get.status, 403, `${role} GET must be rejected`);
    const put = await fetch(`${base}/staff/notification-preferences`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ digestEnabled: true }),
    });
    assert.equal(put.status, 403, `${role} PUT must be rejected`);
  }
});

test("a firm member without a tenant firm is rejected", async () => {
  const principal: Principal = {
    userId: adminId,
    role: "firm_admin",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
  const base = await listen(appFor(principal, staffRouter));
  const res = await fetch(`${base}/staff/notification-preferences`);
  assert.equal(res.status, 403);
});

test("a multi-firm member saves preferences per firm independently (composite key)", async () => {
  // Same user, two tenants: the row key is (userId, firmId), so firm B's
  // save must neither collide with nor clobber the firm-A row, and each
  // firm's GET reads its own state.
  const baseA = await listen(appFor(principalFor("firm_staff", staffId), staffRouter));
  const baseB = await listen(
    appFor(principalFor("firm_staff", staffId, firm2Id), staffRouter),
  );

  // Full payload (not a partial merge): the earlier test already saved a
  // firm-A row for this user, so pin every field to a known state.
  const savedA = await fetch(`${baseA}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: false,
      pushEnabled: true,
      email: null,
    }),
  });
  assert.equal(savedA.status, 200);

  const savedB = await fetch(`${baseB}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      digestEnabled: true,
      emailEnabled: true,
      email: `firm-b-${SALT}@test.example`,
    }),
  });
  assert.equal(savedB.status, 200, "firm B's save must not 500 on firm A's row");
  const bodyB = (await savedB.json()) as PrefsBody;
  assert.deepEqual(bodyB, {
    digestEnabled: true,
    emailEnabled: true,
    pushEnabled: false, // firm A's pushEnabled must not bleed into firm B
    email: `firm-b-${SALT}@test.example`,
    emailVerifiedAt: null,
  });

  // Each firm context reads back ITS OWN row.
  const readA = (await (
    await fetch(`${baseA}/staff/notification-preferences`)
  ).json()) as PrefsBody;
  assert.deepEqual(readA, {
    digestEnabled: true,
    emailEnabled: false,
    pushEnabled: true,
    email: null,
    emailVerifiedAt: null,
  });

  // Two independent rows, one per firm, both pinned to the principal.
  const rows = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(eq(staffNotificationPreferencesTable.userId, staffId));
  const byFirm = new Map(rows.map((r) => [r.firmId, r]));
  assert.ok(byFirm.get(firmId), "firm A row exists");
  assert.ok(byFirm.get(firm2Id), "firm B row exists");
  assert.equal(byFirm.get(firmId)!.pushEnabled, true);
  assert.equal(byFirm.get(firm2Id)!.pushEnabled, false);
  assert.equal(byFirm.get(firm2Id)!.email, `firm-b-${SALT}@test.example`);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

// Capture relay: a local HTTP server standing in for the messaging webhook.
function startRelay(): Promise<{
  url: string;
  received: Array<{ body: Record<string, unknown>; opToken: string | null }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ body: Record<string, unknown>; opToken: string | null }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({
        body: JSON.parse(raw) as Record<string, unknown>,
        opToken: (req.headers["x-op-token"] as string | undefined) ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

test("request-email-verification without a saved email is a 400", async () => {
  const base = await listen(appFor(principalFor("firm_staff", verifyId), staffRouter));
  // No preference row at all yet.
  const bare = await fetch(
    `${base}/staff/notification-preferences/request-email-verification`,
    { method: "POST" },
  );
  assert.equal(bare.status, 400);

  // A row without an address is the same 400.
  await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ digestEnabled: true }),
  });
  const noEmail = await fetch(
    `${base}/staff/notification-preferences/request-email-verification`,
    { method: "POST" },
  );
  assert.equal(noEmail.status, 400);
});

test("a dark relay answers 202 but stores and sends nothing (no oracle)", async () => {
  delete process.env.MESSAGING_WEBHOOK_URL;
  const base = await listen(appFor(principalFor("firm_staff", verifyId), staffRouter));
  await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: `verify-${SALT}@test.example` }),
  });
  const res = await fetch(
    `${base}/staff/notification-preferences/request-email-verification`,
    { method: "POST" },
  );
  assert.equal(res.status, 202, "identical response whether or not a relay exists");
  const row = await verifyRow(verifyId);
  assert.equal(row.emailVerifyCodeHash, null, "no code stored while dark");
  assert.equal(row.emailVerifyExpiresAt, null);
});

test("request dispatches the raw {email, code} to the relay; confirm verifies", async () => {
  const relay = await startRelay();
  process.env.MESSAGING_WEBHOOK_URL = relay.url;
  process.env.MESSAGING_WEBHOOK_TOKEN = `relay-secret-${SALT}`;
  try {
    const base = await listen(
      appFor(principalFor("firm_staff", verifyId), staffRouter),
    );
    const res = await fetch(
      `${base}/staff/notification-preferences/request-email-verification`,
      { method: "POST" },
    );
    assert.equal(res.status, 202);

    // The deliberate SEC-12 exception: the raw address+code cross to the
    // relay (the address-handling boundary), under the shared secret.
    assert.equal(relay.received.length, 1);
    const dispatch = relay.received[0];
    assert.equal(dispatch.opToken, `relay-secret-${SALT}`);
    assert.equal(dispatch.body.kind, "staff_email_verify");
    assert.equal(dispatch.body.email, `verify-${SALT}@test.example`);
    const code = dispatch.body.code as string;
    assert.match(code, /^\d{6}$/);

    // Only the sha256 is stored, with a future expiry.
    const pending = await verifyRow(verifyId);
    assert.equal(pending.emailVerifyCodeHash, sha256Hex(code));
    assert.ok(!JSON.stringify(pending).includes(code) || code === "", "raw code never stored");
    assert.ok(pending.emailVerifyExpiresAt!.getTime() > Date.now());

    // A wrong guess is a 400 and does not verify.
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await fetch(
      `${base}/staff/notification-preferences/confirm-email`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ code: wrongCode }),
      },
    );
    assert.equal(wrong.status, 400);
    assert.equal((await verifyRow(verifyId)).emailVerifiedAt, null);

    // The right code verifies, burns the code and stamps emailVerifiedAt.
    const ok = await fetch(
      `${base}/staff/notification-preferences/confirm-email`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ code }),
      },
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as PrefsBody;
    assert.ok(body.emailVerifiedAt, "response carries the verification stamp");
    const verified = await verifyRow(verifyId);
    assert.ok(verified.emailVerifiedAt);
    assert.equal(verified.emailVerifyCodeHash, null, "code is single-use");
    assert.equal(verified.emailVerifyExpiresAt, null);

    // Replaying the burnt code fails.
    const replay = await fetch(
      `${base}/staff/notification-preferences/confirm-email`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ code }),
      },
    );
    assert.equal(replay.status, 400);
  } finally {
    delete process.env.MESSAGING_WEBHOOK_URL;
    delete process.env.MESSAGING_WEBHOOK_TOKEN;
    await relay.close();
  }
});

test("a concurrent address swap between read and confirm cannot stamp the new address (CAS)", async () => {
  // The race: request A reads the row and validates its code; a PUT swaps the
  // address (clearing hash + verification, possibly followed by a fresh code
  // for the NEW address) and commits; request A's write then lands. With a
  // bare (userId, firmId) predicate the stamp would land on the unverified
  // new address. The route's UPDATE is compare-and-set on the stored code
  // hash, so the stamp can only ever land on the exact pending-code state the
  // presented code proved.
  //
  // Plant the pre-race state: address A with a valid pending code.
  await getDb()
    .update(staffNotificationPreferencesTable)
    .set({
      email: `race-a-${SALT}@test.example`,
      emailVerifiedAt: null,
      emailVerifyCodeHash: sha256Hex("111111"),
      emailVerifyExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, verifyId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    );
  // The interleaved PUT commits: new address, verification state reset, and a
  // NEW code already pending for it (the worst shape — a bare-key update
  // would burn the new code AND stamp the new address).
  await getDb()
    .update(staffNotificationPreferencesTable)
    .set({
      email: `race-b-${SALT}@test.example`,
      emailVerifiedAt: null,
      emailVerifyCodeHash: sha256Hex("222222"),
      emailVerifyExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, verifyId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    );
  // Request A's confirm arrives with the OLD code: 400, and the new address
  // stays unverified with its own pending code intact.
  const base = await listen(appFor(principalFor("firm_staff", verifyId), staffRouter));
  const res = await fetch(
    `${base}/staff/notification-preferences/confirm-email`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: "111111" }),
    },
  );
  assert.equal(res.status, 400);
  const row = await verifyRow(verifyId);
  assert.equal(row.emailVerifiedAt, null, "the swapped-in address must not be stamped");
  assert.equal(row.emailVerifyCodeHash, sha256Hex("222222"), "the new pending code survives");
  await clearActionFailures(`everifyc:${verifyId}`);
  // Restore the pre-race address so the later address-change tests see the
  // state the earlier tests left behind (unverified is fine — they re-stamp).
  const restore = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: `verify-${SALT}@test.example` }),
  });
  assert.equal(restore.status, 200);
});

test("the confirm-email UPDATE is compare-and-set on the stored code hash (tripwire)", async () => {
  // The behavioral test above passes even under the pre-CAS code (the READ
  // fails after the swap). What the read cannot guarantee is the window
  // BETWEEN read and write — only the UPDATE's own predicate closes it, and
  // no black-box test can interpose inside one request. Pin it in source, the
  // route-posture idiom.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./staff.ts", import.meta.url), "utf8");
  const confirmAt = src.indexOf("confirm-email");
  assert.ok(confirmAt >= 0);
  const updateAt = src.indexOf(".update(staffNotificationPreferencesTable)", confirmAt);
  assert.ok(updateAt >= 0, "the confirm route updates the prefs row");
  const whereAt = src.indexOf(".where(", updateAt);
  const returningAt = src.indexOf(".returning()", whereAt);
  const wherePredicate = src.slice(whereAt, returningAt);
  assert.ok(
    wherePredicate.includes("emailVerifyCodeHash, presentedHash"),
    "the stamp's WHERE must carry the presented code hash — a bare (userId, firmId) predicate re-opens the swap race",
  );
});

test("an expired code is rejected", async () => {
  // Plant a known, already-expired code directly.
  await getDb()
    .update(staffNotificationPreferencesTable)
    .set({
      emailVerifiedAt: null,
      emailVerifyCodeHash: sha256Hex("123456"),
      emailVerifyExpiresAt: new Date(Date.now() - 1_000),
    })
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, verifyId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    );
  const base = await listen(appFor(principalFor("firm_staff", verifyId), staffRouter));
  const res = await fetch(
    `${base}/staff/notification-preferences/confirm-email`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: "123456" }),
    },
  );
  assert.equal(res.status, 400, "the right code after expiry is still rejected");
  assert.equal((await verifyRow(verifyId)).emailVerifiedAt, null);
});

test("changing (or clearing) the email clears the verification; re-saving the same keeps it", async () => {
  // Start verified with a pending-free state.
  await getDb()
    .update(staffNotificationPreferencesTable)
    .set({
      emailVerifiedAt: new Date(),
      emailVerifyCodeHash: sha256Hex("999999"),
      emailVerifyExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, verifyId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    );
  const base = await listen(appFor(principalFor("firm_staff", verifyId), staffRouter));

  // Re-saving the SAME address keeps the verified state.
  const same = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: `verify-${SALT}@test.example` }),
  });
  assert.equal(same.status, 200);
  assert.ok(((await same.json()) as PrefsBody).emailVerifiedAt);

  // A DIFFERENT address drops verification AND any pending code.
  const changed = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: `other-${SALT}@test.example` }),
  });
  assert.equal(changed.status, 200);
  assert.equal(((await changed.json()) as PrefsBody).emailVerifiedAt, null);
  let row = await verifyRow(verifyId);
  assert.equal(row.emailVerifiedAt, null);
  assert.equal(row.emailVerifyCodeHash, null);
  assert.equal(row.emailVerifyExpiresAt, null);

  // Clearing the address is a change too.
  await getDb()
    .update(staffNotificationPreferencesTable)
    .set({ emailVerifiedAt: new Date() })
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, verifyId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    );
  const clearedRes = await fetch(`${base}/staff/notification-preferences`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: null }),
  });
  assert.equal(clearedRes.status, 200);
  row = await verifyRow(verifyId);
  assert.equal(row.email, null);
  assert.equal(row.emailVerifiedAt, null);
});
