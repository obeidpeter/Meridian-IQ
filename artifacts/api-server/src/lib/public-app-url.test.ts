import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicAppUrlConfigured,
  checkPublicAppUrl,
  DEVELOPMENT_PUBLIC_APP_URL,
  publicAppLink,
  publicAppUrl,
} from "./public-app-url";

// R112: the public origin is read from PUBLIC_APP_URL and from nowhere else.
// These are DB-free (test:pure) — the verdicts, the production boot gate and
// the fragment-carrying links are pure functions of the environment.

const HOST = "app.valo.example";

test("a trimmed https origin passes in every environment", () => {
  for (const NODE_ENV of ["development", "test", "production"]) {
    const verdict = checkPublicAppUrl({
      NODE_ENV,
      PUBLIC_APP_URL: `  https://${HOST}/base  `,
    });
    assert.equal(verdict.ok, true, NODE_ENV);
    if (verdict.ok) assert.equal(verdict.url.origin, `https://${HOST}`);
  }
});

test("loopback http is accepted only outside production", () => {
  for (const PUBLIC_APP_URL of [
    "http://localhost:5173",
    "http://127.0.0.1:4000",
  ]) {
    assert.equal(
      checkPublicAppUrl({ NODE_ENV: "test", PUBLIC_APP_URL }).ok,
      true,
    );
    const production = checkPublicAppUrl({
      NODE_ENV: "production",
      PUBLIC_APP_URL,
    });
    assert.equal(production.ok, false);
    if (!production.ok) assert.match(production.reason, /https/);
  }
  assert.equal(
    checkPublicAppUrl({ NODE_ENV: "test", PUBLIC_APP_URL: `http://${HOST}` })
      .ok,
    false,
    "non-loopback http is refused everywhere",
  );
});

test("unset, relative, non-https and credentialed values are refused with value-free reasons", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /not set/],
    [{ PUBLIC_APP_URL: "   " }, /not set/],
    [{ PUBLIC_APP_URL: "reset-password" }, /absolute URL/],
    [{ PUBLIC_APP_URL: `ftp://${HOST}` }, /https/],
    [{ PUBLIC_APP_URL: `https://user:secret@${HOST}` }, /credentials/],
  ];
  for (const [env, expected] of cases) {
    const verdict = checkPublicAppUrl({ NODE_ENV: "production", ...env });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.match(verdict.reason, expected);
      assert.doesNotMatch(
        verdict.reason,
        /valo\.example|secret|reset-password/,
      );
    }
    assert.equal(publicAppUrl({ NODE_ENV: "production", ...env }), null);
  }
});

test("the production boot gate throws with the reason and never the value, and is inert elsewhere", () => {
  assert.throws(
    () => assertPublicAppUrlConfigured({ NODE_ENV: "production" }),
    /safe public origin.*not set/,
  );
  assert.throws(
    () =>
      assertPublicAppUrlConfigured({
        NODE_ENV: "production",
        PUBLIC_APP_URL: `http://${HOST}`,
      }),
    (error: unknown) =>
      error instanceof Error &&
      /https/.test(error.message) &&
      !error.message.includes(HOST),
  );
  assert.doesNotThrow(() =>
    assertPublicAppUrlConfigured({
      NODE_ENV: "production",
      PUBLIC_APP_URL: `https://${HOST}`,
    }),
  );
  assert.doesNotThrow(() =>
    assertPublicAppUrlConfigured({ NODE_ENV: "development" }),
  );
  assert.doesNotThrow(() => assertPublicAppUrlConfigured({ NODE_ENV: "test" }));
});

test("public links ride the configured origin with the credential in the fragment", () => {
  const token = "abc def+/=~";
  const link = publicAppLink(
    "/reset-password",
    { token },
    { NODE_ENV: "production", PUBLIC_APP_URL: `https://${HOST}/base` },
  );
  assert.ok(link);
  const url = new URL(link);
  assert.equal(url.origin, `https://${HOST}`);
  assert.equal(url.pathname, "/reset-password");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), token);
});

test("without a safe origin, links go dark in production and fall back to the local origin elsewhere", () => {
  assert.equal(
    publicAppLink(
      "/reset-password",
      { token: "t" },
      { NODE_ENV: "production" },
    ),
    null,
  );
  assert.equal(
    publicAppLink(
      "/invoice-room",
      { token: "t" },
      { NODE_ENV: "production", PUBLIC_APP_URL: `http://${HOST}` },
    ),
    null,
  );
  assert.equal(
    publicAppLink(
      "/reset-password",
      { token: "t" },
      { NODE_ENV: "development" },
    ),
    `${DEVELOPMENT_PUBLIC_APP_URL}/reset-password#token=t`,
  );
});
