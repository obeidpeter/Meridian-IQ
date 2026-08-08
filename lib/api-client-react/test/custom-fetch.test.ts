/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiTimeoutError,
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from "../src/custom-fetch.ts";

test("customFetch aborts at the caller timeout without forwarding timeoutMs", async () => {
  const originalFetch = globalThis.fetch;
  let observedInit: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    observedInit = init;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  };

  try {
    await assert.rejects(
      customFetch("https://example.test/slow", { timeoutMs: 5 }),
      (error: unknown) =>
        error instanceof ApiTimeoutError && error.timeoutMs === 5,
    );
    assert.equal("timeoutMs" in (observedInit ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customFetch rejects invalid timeout values before sending", async () => {
  await assert.rejects(
    customFetch("https://example.test/no-send", { timeoutMs: 0 }),
    /timeoutMs must be between/,
  );
  await assert.rejects(
    customFetch("https://example.test/no-send", {
      timeoutMs: 2_147_483_648,
    }),
    /timeoutMs must be between/,
  );
});

test("customFetch timeout bounds a stalled response body parser", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response("ignored", {
      headers: { "content-type": "application/json" },
    });
    response.text = () => new Promise(() => {});
    return response;
  };

  try {
    await assert.rejects(
      customFetch("https://example.test/stalled-body", {
        responseType: "json",
        timeoutMs: 5,
      }),
      ApiTimeoutError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customFetch scopes credentials and CSRF markers to unsafe API calls", async () => {
  const originalFetch = globalThis.fetch;
  const observed: Array<{
    url: string;
    headers: Headers;
    credentials: RequestCredentials | undefined;
  }> = [];
  let tokenReads = 0;
  globalThis.fetch = async (input, init) => {
    observed.push({
      url: String(input),
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
    });
    return new Response(null, { status: 204 });
  };
  setBaseUrl("https://api.example.test");
  setAuthTokenGetter(() => {
    tokenReads += 1;
    return "mobile-secret";
  });

  try {
    await customFetch("/api/items");
    await customFetch("/api/items", { method: "POST" });
    await customFetch("https://third-party.example/upload", { method: "POST" });

    assert.equal(observed[0].headers.has("authorization"), true);
    assert.equal(observed[0].headers.has("x-meridian-csrf"), false);
    assert.equal(
      observed[1].headers.get("authorization"),
      "Bearer mobile-secret",
    );
    assert.equal(observed[1].headers.get("x-meridian-csrf"), "1");
    assert.equal(observed[2].headers.has("authorization"), false);
    assert.equal(observed[2].headers.has("x-meridian-csrf"), false);
    assert.equal(observed[2].credentials, "omit");
    assert.equal(tokenReads, 2);
  } finally {
    setAuthTokenGetter(null);
    setBaseUrl(null);
    globalThis.fetch = originalFetch;
  }
});

test("customFetch timeout also bounds a stalled auth token getter", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("ok");
  };
  setBaseUrl("https://api.example.test");
  setAuthTokenGetter(() => new Promise(() => {}));
  try {
    await assert.rejects(
      customFetch("/auth-stall", { timeoutMs: 5 }),
      ApiTimeoutError,
    );
    assert.equal(fetchCalled, false);
  } finally {
    setAuthTokenGetter(null);
    setBaseUrl(null);
    globalThis.fetch = originalFetch;
  }
});
