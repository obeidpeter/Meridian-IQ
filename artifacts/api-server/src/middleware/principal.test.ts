import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { requireCsrfHeader } from "./principal.ts";
import { SESSION_COOKIE } from "../modules/auth/session.ts";
import { listen, closeAllServers } from "../test-helpers/route-harness.ts";

// The custom-header CSRF guard (SEC-02). It is the ONLY cross-site defense —
// the session cookie is deliberately SameSite=None for the preview iframe —
// so its behavior is pinned here: a cookie-authenticated state-changing
// request without the x-meridian-csrf header must be refused, everything
// that cannot be forged cross-site must pass. Wired exactly as app.ts does:
// cookie-parser first (the guard reads req.cookies), guard before routes.

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

test("requests without a session cookie pass (bearer/dev-header clients)", async () => {
  const base = await listen(guardedApp());
  // No cookie at all — cannot be forged cross-site (the browser attaches
  // nothing), and bearer tokens are attacker-unreachable headers anyway.
  const bare = await fetch(`${base}/api/invoices`, { method: "POST" });
  assert.equal(bare.status, 200);
  // An unrelated cookie is not the session cookie.
  const unrelated = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: { cookie: "theme=dark" },
  });
  assert.equal(unrelated.status, 200);
});

test("public session endpoints stay reachable with a cookie and no header", async () => {
  const base = await listen(guardedApp());
  for (const path of ["/api/auth/login", "/api/auth/logout"]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: COOKIE,
    });
    assert.equal(res.status, 200, `${path} is on the public allowlist`);
  }
});
