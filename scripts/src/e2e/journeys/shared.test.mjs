import assert from "node:assert/strict";
import test from "node:test";
import { signOutFromApp } from "./shared.mjs";

const BASE = "http://127.0.0.1:8091";

function fixture(overrides = {}) {
  const calls = [];
  const page = {
    getByTestId(id) {
      assert.equal(id, "button-sign-out");
      return {
        first: () => ({
          click: async () => {
            calls.push("click");
          },
        }),
      };
    },
    async waitForURL(predicate, options) {
      calls.push("navigation");
      assert.equal(
        options,
        undefined,
        "Keep Playwright's existing navigation timeout",
      );
      for (const destination of [
        `${BASE}/login`,
        `${BASE}/login?reason=signed-out`,
        `${BASE}/login?returnTo=%2Fconsole%2F&reason=signed-out`,
        `${BASE}/login?reason=local-signout`,
      ]) {
        assert.equal(predicate(new URL(destination)), true, destination);
      }
      for (const destination of [
        `${BASE}/console/?reason=signed-out`,
        `${BASE}/login/extra?reason=signed-out`,
        "http://127.0.0.1:8092/login?reason=signed-out",
        "https://127.0.0.1:8091/login?reason=signed-out",
        "https://other.example/login?reason=signed-out",
      ]) {
        assert.equal(predicate(new URL(destination)), false, destination);
      }
    },
    url: () => `${BASE}/login?reason=signed-out`,
    async waitForSelector(selector, options) {
      calls.push("login ready");
      assert.equal(selector, '[data-testid="input-email"]');
      assert.deepEqual(options, { timeout: 10000 });
    },
    ...overrides,
  };
  return { page, calls };
}

test("sign-out waits for confirmed same-origin login, then the login form", async () => {
  const { page, calls } = fixture();
  await signOutFromApp(page, BASE);
  assert.deepEqual(calls, ["click", "navigation", "login ready"]);
});

test("failed sign-out navigation is not swallowed or treated as login readiness", async () => {
  const failure = new Error("navigation failed");
  const { page, calls } = fixture({
    async waitForURL() {
      throw failure;
    },
  });
  await assert.rejects(
    signOutFromApp(page, BASE),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["click"]);
});

test("confirmed redirect still fails when the login form does not become ready", async () => {
  const failure = new Error("login form missing");
  const { page, calls } = fixture({
    async waitForSelector() {
      throw failure;
    },
  });
  await assert.rejects(
    signOutFromApp(page, BASE),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["click", "navigation"]);
});

for (const reason of ["local-signout", "expired", "signed-out-later", null]) {
  test(`unconfirmed logout reason ${reason} is rejected before login readiness`, async () => {
    const { page, calls } = fixture({
      url: () => `${BASE}/login${reason ? `?reason=${reason}` : ""}`,
    });
    await assert.rejects(
      signOutFromApp(page, BASE),
      /must confirm server revocation/,
    );
    assert.deepEqual(calls, ["click", "navigation"]);
  });
}
