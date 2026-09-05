import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { signOutFromApp } from "./shared.mjs";

const BASE = "http://127.0.0.1:8091";

function response({
  url = `${BASE}/api/auth/logout`,
  method = "POST",
  status = 204,
} = {}) {
  return {
    url: () => url,
    request: () => ({ method: () => method }),
    status: () => status,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const calls = [];
  const page = {
    async waitForResponse(predicate, options) {
      calls.push("response listener");
      assert.equal(
        options,
        undefined,
        "Keep Playwright's existing response timeout",
      );
      assert.equal(predicate(response()), true);
      assert.equal(
        predicate(response({ status: 500 })),
        true,
        "Inspect failures instead of ignoring them",
      );
      for (const candidate of [
        response({ method: "GET" }),
        response({ url: `${BASE}/api/auth/logout/extra` }),
        response({ url: `${BASE}/api/auth/logout?other=1` }),
        response({ url: `${BASE}/api/auth/revoke-sessions` }),
        response({ url: "http://127.0.0.1:8092/api/auth/logout" }),
        response({ url: "https://127.0.0.1:8091/api/auth/logout" }),
        response({ url: "https://other.example/api/auth/logout" }),
      ])
        assert.equal(predicate(candidate), false, candidate.url());
      return response();
    },
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
        `${BASE}/login?reason=signed-out`,
        `${BASE}/login?returnTo=%2Fconsole%2F&reason=signed-out`,
      ]) {
        assert.equal(predicate(new URL(destination)), true, destination);
      }
      for (const destination of [
        `${BASE}/login`,
        `${BASE}/login?reason=local-signout`,
        `${BASE}/login?reason=expired`,
        `${BASE}/login?reason=signed-out-later`,
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
  assert.deepEqual(calls, [
    "response listener",
    "click",
    "navigation",
    "login ready",
  ]);
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
  assert.deepEqual(calls, ["response listener", "click"]);
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
  assert.deepEqual(calls, ["response listener", "click", "navigation"]);
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
    assert.deepEqual(calls, ["response listener", "click", "navigation"]);
  });
}

for (const status of [200, 401, 500]) {
  test(`logout HTTP ${status} cannot pass via an old confirmed URL`, async () => {
    const { page, calls } = fixture({
      async waitForResponse() {
        return response({ status });
      },
    });
    await assert.rejects(
      signOutFromApp(page, BASE),
      /server's 204 confirmation/,
    );
    assert.deepEqual(calls, ["click"]);
  });
}

test("missing logout response cannot pass via an old confirmed URL", async () => {
  const failure = new Error("logout response timed out");
  const { page, calls } = fixture({
    async waitForResponse() {
      throw failure;
    },
  });
  await assert.rejects(
    signOutFromApp(page, BASE),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["click"]);
});

for (const initialUrl of [`${BASE}/login`, `${BASE}/login?reason=signed-out`]) {
  test(
    `logout from ${initialUrl} waits for this response, redirect and form`,
    { timeout: 1000 },
    async (t) => {
      const revoked = deferred();
      const navigated = deferred();
      const form = deferred();
      t.after(() => {
        revoked.resolve(response());
        navigated.resolve();
        form.resolve();
      });
      let currentUrl = initialUrl;
      let settled = false;
      const { page, calls } = fixture({
        waitForResponse(predicate) {
          calls.push("response listener");
          assert.equal(predicate(response()), true);
          return revoked.promise;
        },
        async waitForURL(predicate) {
          calls.push("navigation");
          // Match Playwright: an already-matching URL resolves immediately.
          if (!predicate(new URL(currentUrl))) await navigated.promise;
          assert.equal(predicate(new URL(currentUrl)), true);
        },
        url: () => currentUrl,
        waitForSelector() {
          calls.push("login ready");
          return form.promise;
        },
      });
      const done = signOutFromApp(page, BASE).finally(() => {
        settled = true;
      });
      await setImmediate();
      assert.equal(settled, false);
      assert.deepEqual(calls, ["response listener", "click"]);
      revoked.resolve(response());
      await setImmediate();
      assert.equal(settled, false);
      if (initialUrl === `${BASE}/login`) {
        assert.deepEqual(calls, ["response listener", "click", "navigation"]);
      }
      currentUrl = `${BASE}/login?reason=signed-out`;
      navigated.resolve();
      await setImmediate();
      assert.equal(
        settled,
        false,
        "the new login form must still become ready",
      );
      assert.deepEqual(calls, [
        "response listener",
        "click",
        "navigation",
        "login ready",
      ]);
      form.resolve();
      await done;
    },
  );
}
