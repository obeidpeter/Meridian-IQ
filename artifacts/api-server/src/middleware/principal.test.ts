import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { requireCsrfHeader } from "./principal.ts";
import { SESSION_COOKIE } from "../modules/auth/session.ts";
import { listen, closeAllServers } from "../test-helpers/route-harness.ts";

// The custom-header CSRF guard (SEC-02). It is the ONLY cross-site defense —
// the session cookie is deliberately SameSite=None for the preview iframe —
// so its behavior is pinned here: every browser-facing state-changing request
// needs the x-meridian-csrf header, including login/logout and bearer clients.
// Dedicated machine webhooks are the only exception because their non-simple
// token headers provide the same cross-site boundary.

function guardedApp() {
  const app = express();
  app.use(cookieParser());
  app.use(requireCsrfHeader);
  app.all("*path", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

after(async () => {
  await closeAllServers();
});

const COOKIE = { cookie: `${SESSION_COOKIE}=some-session-token` };

test("cookie-authenticated mutation without the header is refused", async () => {
  const base = await listen(guardedApp());
  const res = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: COOKIE,
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /CSRF/);
});

test("cookie-authenticated mutation WITH the header passes", async () => {
  const base = await listen(guardedApp());
  const res = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: { ...COOKIE, "x-meridian-csrf": "1" },
  });
  assert.equal(res.status, 200);
});

test("safe methods pass with a cookie and no header", async () => {
  const base = await listen(guardedApp());
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const res = await fetch(`${base}/api/invoices`, {
      method,
      headers: COOKIE,
    });
    assert.equal(res.status, 200, `${method} must not require the header`);
  }
});

test("browser-facing mutations require the header even without a cookie", async () => {
  const base = await listen(guardedApp());
  const bare = await fetch(`${base}/api/invoices`, { method: "POST" });
  assert.equal(bare.status, 403);

  const bearer = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "x-meridian-csrf": "1",
    },
  });
  assert.equal(bearer.status, 200);
});

test("public session endpoints still require the CSRF marker", async () => {
  const base = await listen(guardedApp());
  for (const path of ["/api/auth/login", "/api/auth/logout"]) {
    const missing = await fetch(`${base}${path}`, {
      method: "POST",
      headers: COOKIE,
    });
    assert.equal(
      missing.status,
      403,
      `${path} refuses a simple cross-site POST`,
    );

    const marked = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...COOKIE, "x-meridian-csrf": "1" },
    });
    assert.equal(marked.status, 200, `${path} accepts the first-party marker`);
  }
});

test("token-authenticated machine webhooks are exempt", async () => {
  const base = await listen(guardedApp());
  for (const path of [
    "/api/inbound/email",
    "/api/inbound/whatsapp",
    "/api/billing/payments/confirm",
    "/api/collections/inbound",
  ]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "x-op-token": "machine-secret" },
    });
    assert.equal(
      res.status,
      200,
      `${path} uses its machine credential boundary`,
    );
  }
});
