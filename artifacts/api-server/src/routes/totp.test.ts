import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, pool, usersTable, membershipsTable } from "@workspace/db";
import authRouter from "./auth.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { hashPassword, verifySessionToken, issueSessionToken } from "../modules/auth/session.ts";
import {
  totpCode,
  totpStep,
  hashRecoveryCode,
  generateTotpSecret,
  generateRecoveryCodes,
  TOTP_STEP_SECONDS,
} from "../modules/auth/totp.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// TOTP two-factor routes (SEC-02): enrolment is opt-in and changes nothing
// until activated; an enrolled login yields an mfa pending token instead of a
// session; the challenge endpoint redeems token + code (or a one-time recovery
// code) for the real session, with replay blocked inside the code's own
// window and guessing capped by the shared action throttle.

const SALT = makeRunSalt();
const PASSWORD = "correct-horse-battery";
const STEP_MS = TOTP_STEP_SECONDS * 1000;

// userA walks the full enrolment + challenge journey; userB exercises the
// challenge throttle; userC exercises disable; userD the TOTP_REQUIRED_ROLES
// refusal. Separate users keep the totp:<userId> throttle keys independent.
const userA = {
  id: randomUUID(),
  email: `totp-a-${SALT}@test.local`,
  role: "firm_admin" as const,
};
const userB = {
  id: randomUUID(),
  email: `totp-b-${SALT}@test.local`,
  role: "firm_staff" as const,
};
const userC = {
  id: randomUUID(),
  email: `totp-c-${SALT}@test.local`,
  role: "firm_staff" as const,
};
const userD = {
  id: randomUUID(),
  email: `totp-d-${SALT}@test.local`,
  role: "firm_admin" as const,
};
// userE/userF race the same code concurrently (CAS single-use); userG fires a
// burst of guesses (bump-first throttle); userH holds TWO memberships for the
// any-membership TOTP_REQUIRED_ROLES check.
const userE = {
  id: randomUUID(),
  email: `totp-e-${SALT}@test.local`,
  role: "firm_staff" as const,
};
const userF = {
  id: randomUUID(),
  email: `totp-f-${SALT}@test.local`,
  role: "firm_staff" as const,
};
const userG = {
  id: randomUUID(),
  email: `totp-g-${SALT}@test.local`,
  role: "firm_staff" as const,
};
const userH = {
  id: randomUUID(),
  email: `totp-h-${SALT}@test.local`,
  role: "firm_staff" as const,
};

function principalFor(user: { id: string; role: Principal["role"] }): Principal {
  return {
    userId: user.id,
    role: user.role,
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
}

// A 6-digit string guaranteed not to be valid for `secret` at any step near
// now (±2 steps, so a window shift between computing here and verifying
// server-side cannot make it accidentally valid).
function wrongCodeFor(secret: string): string {
  const now = Date.now();
  const valid = new Set(
    [-2, -1, 0, 1, 2].map((d) => totpCode(secret, now + d * STEP_MS)),
  );
  for (let i = 0; ; i++) {
    const candidate = String(i).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  return setCookie && setCookie.includes("miq_session=") ? setCookie : null;
}

before(async () => {
  const db = getDb();
  for (const user of [userA, userB, userC, userD, userE, userF, userG]) {
    await db.insert(usersTable).values({
      id: user.id,
      email: user.email,
      passwordHash: await hashPassword(PASSWORD),
    });
    await db
      .insert(membershipsTable)
      .values({ userId: user.id, role: user.role, firmId: null });
  }
  // userH: the benign firm_staff membership FIRST (so a memberships[0]-only
  // check would see it), then a cross-tenant operator membership.
  await db.insert(usersTable).values({
    id: userH.id,
    email: userH.email,
    passwordHash: await hashPassword(PASSWORD),
  });
  await db
    .insert(membershipsTable)
    .values({ userId: userH.id, role: "firm_staff", firmId: null });
  await db
    .insert(membershipsTable)
    .values({ userId: userH.id, role: "operator", firmId: null });
});

after(async () => {
  await closeAllServers();
});

test("unenrolled login is exactly today's behaviour: cookie set, no mfa fields", async () => {
  const base = await listen(appFor(principalFor(userA), authRouter));
  const res = await postJson(base, "/auth/login", {
    email: userA.email,
    password: PASSWORD,
  });
  assert.equal(res.status, 200);
  assert.ok(sessionCookie(res), "session cookie set");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.userId, userA.id);
  assert.ok(!body.mfaRequired, "mfaRequired absent/false for unenrolled");
  assert.equal(body.mfaToken ?? null, null);
});

test("setup returns secret + otpauth URI + recovery codes once; only hashes stored; login stays normal while pending", async () => {
  const base = await listen(appFor(principalFor(userA), authRouter));
  const res = await postJson(base, "/auth/totp/setup", {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  };
  assert.match(body.secret, /^[A-Z2-7]{32}$/);
  assert.ok(body.otpauthUri.includes("issuer=MeridianIQ"));
  assert.equal(body.recoveryCodes.length, 8);

  const [row] = await getDb()
    .select({
      totpSecret: usersTable.totpSecret,
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userA.id))
    .limit(1);
  assert.equal(row.totpSecret, body.secret);
  assert.equal(row.totpEnabledAt, null, "pending: not yet enabled");
  assert.deepEqual(
    row.totpRecoveryCodes,
    body.recoveryCodes.map(hashRecoveryCode),
    "DB holds sha256 hashes, never the codes",
  );

  // Pending enrolment does not gate login yet.
  const login = await postJson(base, "/auth/login", {
    email: userA.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.ok(sessionCookie(login), "cookie still issued while pending");

  // Stash for the rest of the journey.
  (globalThis as Record<string, unknown>).__totpA = body;
});

test("activate demands a valid current code, then bumps the epoch (revoking old sessions)", async () => {
  const enrolment = (globalThis as Record<string, unknown>).__totpA as {
    secret: string;
    recoveryCodes: string[];
  };
  const base = await listen(appFor(principalFor(userA), authRouter));

  // A session token issued BEFORE activation, to prove revocation.
  const preToken = await issueSessionToken(userA.id, 0);

  const bad = await postJson(base, "/auth/totp/activate", {
    code: wrongCodeFor(enrolment.secret),
  });
  assert.equal(bad.status, 400, "wrong code refuses activation");

  const activationCode = totpCode(enrolment.secret, Date.now());
  const good = await postJson(base, "/auth/totp/activate", {
    code: activationCode,
  });
  assert.equal(good.status, 200);
  // The replay test below must present the EXACT code that was spent — a
  // recomputed "current" code after a step-boundary crossing would be a
  // fresh, valid one.
  (globalThis as Record<string, unknown>).__activationCodeA = activationCode;
  const body = (await good.json()) as Record<string, unknown>;
  assert.equal(body.enabled, true);
  assert.equal(body.recoveryCodesRemaining, 8);
  assert.ok(sessionCookie(good), "caller's cookie re-issued under the new epoch");

  const [row] = await getDb()
    .select({
      totpEnabledAt: usersTable.totpEnabledAt,
      sessionEpoch: usersTable.sessionEpoch,
      totpLastUsedStep: usersTable.totpLastUsedStep,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userA.id))
    .limit(1);
  assert.ok(row.totpEnabledAt, "enabledAt stamped");
  assert.equal(row.sessionEpoch, 1, "epoch bumped: other sessions revoked");
  assert.equal(typeof row.totpLastUsedStep, "number", "activation code is spent");

  // The pre-activation token now predates the user's epoch — exactly the
  // comparison principalFromSessionToken makes to reject it.
  const verified = await verifySessionToken(preToken);
  assert.ok(verified && verified.epoch < row.sessionEpoch, "old token is stale");
});

test("setup on an already-enabled account is a 409", async () => {
  const base = await listen(appFor(principalFor(userA), authRouter));
  const res = await postJson(base, "/auth/totp/setup", {});
  assert.equal(res.status, 409);
});

test("enrolled login returns mfaRequired + mfaToken and NO session (cookie or bearer)", async () => {
  const base = await listen(appFor(principalFor(userA), authRouter));
  const res = await postJson(
    base,
    "/auth/login",
    { email: userA.email, password: PASSWORD },
    // Even the self-identified mobile client gets no bearer token pre-MFA.
    { "x-meridian-client": "mobile" },
  );
  assert.equal(res.status, 200);
  assert.equal(sessionCookie(res), null, "no session cookie before the second factor");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.mfaRequired, true);
  assert.equal(typeof body.mfaToken, "string");
  assert.equal(body.token ?? null, null, "no bearer token either");
  assert.equal(body.userId, userA.id);
  (globalThis as Record<string, unknown>).__mfaTokenA = body.mfaToken;
});

test("challenge: activation code replay refused; next-step code earns the session; replay of that refused too", async () => {
  const enrolment = (globalThis as Record<string, unknown>).__totpA as {
    secret: string;
  };
  const mfaToken = (globalThis as Record<string, unknown>).__mfaTokenA as string;
  const base = await listen(appFor(principalFor(userA), authRouter));

  // The code spent at activation cannot be replayed within its window (and
  // once the window has moved on, it is simply expired — 401 either way).
  const replayed = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: (globalThis as Record<string, unknown>).__activationCodeA as string,
  });
  assert.equal(replayed.status, 401, "activation-step code is spent");

  // The NEXT step's code is inside the ±1 window and not yet used.
  const nextCode = totpCode(enrolment.secret, Date.now() + STEP_MS);
  const ok = await postJson(
    base,
    "/auth/totp/challenge",
    { mfaToken, code: nextCode },
    { "x-meridian-client": "mobile" },
  );
  assert.equal(ok.status, 200);
  assert.ok(sessionCookie(ok), "challenge success sets the session cookie");
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(body.userId, userA.id);
  assert.equal(body.role, userA.role);
  assert.equal(typeof body.token, "string", "mobile client gets its bearer token here");
  assert.ok(!body.mfaRequired);

  // Same code again: single-use within its window.
  const again = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: nextCode,
  });
  assert.equal(again.status, 401, "an accepted code cannot be replayed");
});

test("challenge: a recovery code works exactly once and decrements the pool", async () => {
  const enrolment = (globalThis as Record<string, unknown>).__totpA as {
    recoveryCodes: string[];
  };
  const mfaToken = (globalThis as Record<string, unknown>).__mfaTokenA as string;
  const base = await listen(appFor(principalFor(userA), authRouter));

  const recovery = enrolment.recoveryCodes[0];
  const ok = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: recovery,
  });
  assert.equal(ok.status, 200);
  assert.ok(sessionCookie(ok));

  const [row] = await getDb()
    .select({ totpRecoveryCodes: usersTable.totpRecoveryCodes })
    .from(usersTable)
    .where(eq(usersTable.id, userA.id))
    .limit(1);
  assert.equal(row.totpRecoveryCodes?.length, 7, "burned code removed");
  assert.ok(
    !row.totpRecoveryCodes?.includes(hashRecoveryCode(recovery)),
    "specifically the redeemed one",
  );

  const replay = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: recovery,
  });
  assert.equal(replay.status, 401, "a recovery code redeems once");

  // Status reflects the decrement.
  const status = await fetch(`${base}/auth/totp/status`);
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as {
    enabled: boolean;
    recoveryCodesRemaining: number;
  };
  assert.equal(statusBody.enabled, true);
  assert.equal(statusBody.recoveryCodesRemaining, 7);
});

test("challenge refuses garbage and non-mfa tokens uniformly", async () => {
  const base = await listen(appFor(principalFor(userA), authRouter));
  const garbage = await postJson(base, "/auth/totp/challenge", {
    mfaToken: "not-a-token",
    code: "123456",
  });
  assert.equal(garbage.status, 401);
  // A real SESSION token is not an mfa token (purpose separation).
  const sessionToken = await issueSessionToken(userA.id, 1);
  const confused = await postJson(base, "/auth/totp/challenge", {
    mfaToken: sessionToken,
    code: "123456",
  });
  assert.equal(confused.status, 401);
});

test("wrong codes 401 then throttle to 429 after five failures — even for a valid code", async () => {
  // Enrol userB directly (route journey already covered above).
  const secret = generateTotpSecret();
  const { hashes } = generateRecoveryCodes();
  await getDb()
    .update(usersTable)
    .set({
      totpSecret: secret,
      totpEnabledAt: new Date(),
      totpRecoveryCodes: hashes,
    })
    .where(eq(usersTable.id, userB.id));

  const base = await listen(appFor(principalFor(userB), authRouter));
  const login = await postJson(base, "/auth/login", {
    email: userB.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  const { mfaToken } = (await login.json()) as { mfaToken: string };
  assert.ok(mfaToken);

  for (let i = 0; i < 5; i++) {
    const res = await postJson(base, "/auth/totp/challenge", {
      mfaToken,
      code: wrongCodeFor(secret),
    });
    assert.equal(res.status, 401, `failure ${i + 1} is a uniform 401`);
  }
  // Sixth attempt is throttled BEFORE the code is even considered.
  const throttled = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: totpCode(secret, Date.now()),
  });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
});

test("disable requires password AND a code; clears enrolment and bumps the epoch", async () => {
  const secret = generateTotpSecret();
  const { codes, hashes } = generateRecoveryCodes();
  await getDb()
    .update(usersTable)
    .set({
      totpSecret: secret,
      totpEnabledAt: new Date(),
      totpRecoveryCodes: hashes,
    })
    .where(eq(usersTable.id, userC.id));

  const base = await listen(appFor(principalFor(userC), authRouter));

  const badPassword = await postJson(base, "/auth/totp/disable", {
    password: "wrong-password",
    code: totpCode(secret, Date.now()),
  });
  assert.equal(badPassword.status, 401, "correct code alone is not enough");

  const badCode = await postJson(base, "/auth/totp/disable", {
    password: PASSWORD,
    code: wrongCodeFor(secret),
  });
  assert.equal(badCode.status, 401, "correct password alone is not enough");

  // Password + a recovery code (the "lost my phone" path) succeeds.
  const ok = await postJson(base, "/auth/totp/disable", {
    password: PASSWORD,
    code: codes[3],
  });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(body.enabled, false);
  assert.ok(sessionCookie(ok), "caller's cookie re-issued under the new epoch");

  const [row] = await getDb()
    .select({
      totpSecret: usersTable.totpSecret,
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
      totpLastUsedStep: usersTable.totpLastUsedStep,
      sessionEpoch: usersTable.sessionEpoch,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userC.id))
    .limit(1);
  assert.equal(row.totpSecret, null);
  assert.equal(row.totpEnabledAt, null);
  assert.equal(row.totpRecoveryCodes, null);
  assert.equal(row.totpLastUsedStep, null);
  assert.equal(row.sessionEpoch, 1, "epoch bumped on disable too");

  // Enrolment gone: login is ordinary again.
  const login = await postJson(base, "/auth/login", {
    email: userC.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.ok(sessionCookie(login));
});

test("status reports enrolment without ever exposing the secret", async () => {
  const enabledBase = await listen(appFor(principalFor(userA), authRouter));
  const enabled = await fetch(`${enabledBase}/auth/totp/status`);
  assert.equal(enabled.status, 200);
  const enabledBody = (await enabled.json()) as Record<string, unknown>;
  assert.equal(enabledBody.enabled, true);
  assert.equal(typeof enabledBody.enabledAt, "string");
  assert.equal(enabledBody.recoveryCodesRemaining, 7);
  assert.ok(!("secret" in enabledBody));

  const disabledBase = await listen(appFor(principalFor(userC), authRouter));
  const disabled = await fetch(`${disabledBase}/auth/totp/status`);
  const disabledBody = (await disabled.json()) as Record<string, unknown>;
  assert.equal(disabledBody.enabled, false);
  assert.equal(disabledBody.enabledAt ?? null, null);
  assert.equal(disabledBody.recoveryCodesRemaining ?? null, null);
});

test("TOTP_REQUIRED_ROLES is dark by default and refuses only matching unenrolled roles when set", async () => {
  const base = await listen(appFor(principalFor(userD), authRouter));

  // Dark: unset env, unenrolled firm_admin logs in normally (covered above
  // too, but pinned here against the flag's own default).
  assert.equal(process.env.TOTP_REQUIRED_ROLES, undefined);
  const dark = await postJson(base, "/auth/login", {
    email: userD.email,
    password: PASSWORD,
  });
  assert.equal(dark.status, 200);

  const saved = process.env.TOTP_REQUIRED_ROLES;
  process.env.TOTP_REQUIRED_ROLES = "operator, firm_admin";
  try {
    const refused = await postJson(base, "/auth/login", {
      email: userD.email,
      password: PASSWORD,
    });
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as Record<string, unknown>;
    assert.equal(body.code, "TOTP_REQUIRED");
    assert.equal(sessionCookie(refused), null);

    // A non-matching role is untouched by the flag (userC is firm_staff,
    // unenrolled after the disable test).
    const staffBase = await listen(appFor(principalFor(userC), authRouter));
    const staff = await postJson(staffBase, "/auth/login", {
      email: userC.email,
      password: PASSWORD,
    });
    assert.equal(staff.status, 200);

    // An ENROLLED matching role proceeds to the mfa flow, not a 403.
    const enrolled = await postJson(base, "/auth/login", {
      email: userA.email,
      password: PASSWORD,
    });
    assert.equal(enrolled.status, 200);
    const enrolledBody = (await enrolled.json()) as Record<string, unknown>;
    assert.equal(enrolledBody.mfaRequired, true);
  } finally {
    if (saved === undefined) delete process.env.TOTP_REQUIRED_ROLES;
    else process.env.TOTP_REQUIRED_ROLES = saved;
  }
});

test("concurrent redemption of the same TOTP code yields exactly one session (CAS on the step pin)", async () => {
  const secret = generateTotpSecret();
  await getDb()
    .update(usersTable)
    .set({ totpSecret: secret, totpEnabledAt: new Date() })
    .where(eq(usersTable.id, userE.id));
  const base = await listen(appFor(principalFor(userE), authRouter));
  const login = await postJson(base, "/auth/login", {
    email: userE.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  const { mfaToken } = (await login.json()) as { mfaToken: string };
  assert.ok(mfaToken);

  const now = Date.now();
  const code = totpCode(secret, now);
  const [r1, r2] = await Promise.all([
    postJson(base, "/auth/totp/challenge", { mfaToken, code }),
    postJson(base, "/auth/totp/challenge", { mfaToken, code }),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 401], "exactly one of the pair earns the session");
  const winner = r1.status === 200 ? r1 : r2;
  assert.ok(sessionCookie(winner), "the single winner gets the cookie");

  const [row] = await getDb()
    .select({ totpLastUsedStep: usersTable.totpLastUsedStep })
    .from(usersTable)
    .where(eq(usersTable.id, userE.id))
    .limit(1);
  assert.equal(row.totpLastUsedStep, totpStep(now), "the code's step is pinned exactly once");

  // The redemption tail replayed with the SAME step: the CAS WHERE re-asserts
  // freshness at write time, so even a caller whose earlier read was stale
  // claims zero rows — the guard the route turns into the uniform 401.
  const replayedCas = await getDb()
    .update(usersTable)
    .set({ totpLastUsedStep: totpStep(now) })
    .where(
      and(
        eq(usersTable.id, userE.id),
        or(
          isNull(usersTable.totpLastUsedStep),
          lt(usersTable.totpLastUsedStep, totpStep(now)),
        ),
      ),
    )
    .returning({ id: usersTable.id });
  assert.equal(replayedCas.length, 0, "same-step CAS claims zero rows");

  // And over HTTP the replay stays the uniform 401.
  const again = await postJson(base, "/auth/totp/challenge", { mfaToken, code });
  assert.equal(again.status, 401);
});

test("concurrent redemption of the same recovery code burns it exactly once", async () => {
  const secret = generateTotpSecret();
  const { codes, hashes } = generateRecoveryCodes();
  await getDb()
    .update(usersTable)
    .set({
      totpSecret: secret,
      totpEnabledAt: new Date(),
      totpRecoveryCodes: hashes,
    })
    .where(eq(usersTable.id, userF.id));
  const base = await listen(appFor(principalFor(userF), authRouter));
  const login = await postJson(base, "/auth/login", {
    email: userF.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  const { mfaToken } = (await login.json()) as { mfaToken: string };

  const recovery = codes[0];
  const [r1, r2] = await Promise.all([
    postJson(base, "/auth/totp/challenge", { mfaToken, code: recovery }),
    postJson(base, "/auth/totp/challenge", { mfaToken, code: recovery }),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 401], "a recovery code redeems once even under a race");

  const [row] = await getDb()
    .select({ totpRecoveryCodes: usersTable.totpRecoveryCodes })
    .from(usersTable)
    .where(eq(usersTable.id, userF.id))
    .limit(1);
  // The atomic burn (containment check + removal in ONE statement) fires
  // once: 8 → 7, never 6, and only the redeemed hash is gone.
  assert.deepEqual(row.totpRecoveryCodes, hashes.slice(1), "decremented exactly once");

  const again = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: recovery,
  });
  assert.equal(again.status, 401, "later replays stay refused");
});

test("a concurrent burst of guesses is counted atomically: the cap holds under the race", async () => {
  const secret = generateTotpSecret();
  await getDb()
    .update(usersTable)
    .set({ totpSecret: secret, totpEnabledAt: new Date() })
    .where(eq(usersTable.id, userG.id));
  const base = await listen(appFor(principalFor(userG), authRouter));
  const login = await postJson(base, "/auth/login", {
    email: userG.email,
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  const { mfaToken } = (await login.json()) as { mfaToken: string };

  // Six near-simultaneous wrong guesses: the bump-first gate hands each a
  // distinct post-increment count, so exactly the cap's worth (5) reach the
  // code check and the sixth is refused — a prior-read gate would have let
  // all six through.
  const wrong = wrongCodeFor(secret);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      postJson(base, "/auth/totp/challenge", { mfaToken, code: wrong }),
    ),
  );
  const statuses = results.map((r) => r.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  const throttled = results.find((r) => r.status === 429);
  assert.ok(throttled);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);

  // The window now refuses even a valid code, exactly like sequential failures.
  const valid = await postJson(base, "/auth/totp/challenge", {
    mfaToken,
    code: totpCode(secret, Date.now()),
  });
  assert.equal(valid.status, 429);
});

test("TOTP_REQUIRED_ROLES matches ANY membership, not just the first surfaced one", async () => {
  const base = await listen(appFor(principalFor(userH), authRouter));

  // Flag dark: the dual-role (firm_staff + operator) user signs in normally.
  assert.equal(process.env.TOTP_REQUIRED_ROLES, undefined);
  const dark = await postJson(base, "/auth/login", {
    email: userH.email,
    password: PASSWORD,
  });
  assert.equal(dark.status, 200);
  assert.ok(sessionCookie(dark));

  const saved = process.env.TOTP_REQUIRED_ROLES;
  process.env.TOTP_REQUIRED_ROLES = "operator";
  try {
    // The benign firm_staff membership was inserted FIRST (memberships[0]);
    // the listed operator membership must still refuse the unenrolled login —
    // the effective role is chosen per-request via x-firm-id, so any listed
    // role anywhere on the account demands enrolment before a session exists.
    const refused = await postJson(base, "/auth/login", {
      email: userH.email,
      password: PASSWORD,
    });
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as Record<string, unknown>;
    assert.equal(body.code, "TOTP_REQUIRED");
    assert.equal(sessionCookie(refused), null);

    // A single benign membership is untouched (userC: unenrolled firm_staff
    // after the disable test above).
    const staffBase = await listen(appFor(principalFor(userC), authRouter));
    const staff = await postJson(staffBase, "/auth/login", {
      email: userC.email,
      password: PASSWORD,
    });
    assert.equal(staff.status, 200);
  } finally {
    if (saved === undefined) delete process.env.TOTP_REQUIRED_ROLES;
    else process.env.TOTP_REQUIRED_ROLES = saved;
  }
});

test("no seeded demo account is TOTP-enrolled (opt-in stays opt-in)", async () => {
  // The demo seed sets shared passwords but never touches the totp columns;
  // pin that so e2e logins keep working unchanged. Test-fixture users (this
  // run's and previous runs') all live under @test.local and are excluded.
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM users WHERE totp_enabled_at IS NOT NULL AND email NOT LIKE '%@test.local'",
  );
  assert.equal(Number(rows[0].count), 0);
});
