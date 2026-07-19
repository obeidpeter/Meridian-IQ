import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac.ts";

// Route-posture tripwires. These invariants live in route wiring that no
// module test can reach (there is no HTTP-level harness; the e2e journeys
// exercise happy paths only), yet reverting any of them breaks a shipped
// flow while the whole suite stays green:
//
//  - the SME "Fix with Clerk" card depends on /clerk/explain-failure being
//    reachable with clerk.capture (the capture capability names the client
//    fix-and-retry surface; clerk.ask is the Q&A surface);
//  - /clerk/draft-invoice must check the firm budget BEFORE the module runs,
//    or an exhausted firm still pays for a transcription and only then 429s;
//  - the voice path makes two sequential provider calls, so the route must
//    run OUTSIDE the per-request transaction (app.ts NO_CONTEXT_ROUTES) or a
//    long voice note hits the 30s transaction cap and pins a pooled
//    connection for its whole duration.
//
// Source-text assertions are deliberately narrow: each targets one route
// block, so they fail loudly on the specific revert they guard against.

const src = (rel: string): string =>
  readFileSync(join(import.meta.dirname, "..", rel), "utf8");

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`"${path}"`);
  assert.ok(start >= 0, `route ${path} exists`);
  // Up to the next route registration (or EOF) — enough to hold the handler.
  const next = source.indexOf("router.", source.indexOf("=>", start));
  return source.slice(start, next === -1 ? undefined : next);
}

test("explain-failure stays reachable for the client who owns the failed invoice", () => {
  const block = routeBlock(src("routes/clerk.ts"), "/clerk/explain-failure");
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.capture")'),
    "explain-failure must gate on clerk.capture — clerk.ask would lock out client_users and break the SME fix-and-retry card",
  );
});

test("draft-invoice checks the firm budget before any provider spend", () => {
  const block = routeBlock(src("routes/clerk.ts"), "/clerk/draft-invoice");
  const budgetAt = block.indexOf("assertFirmClerkBudget");
  const moduleAt = block.indexOf("draftInvoiceWithClerk(");
  assert.ok(budgetAt >= 0, "the route checks the budget");
  assert.ok(moduleAt >= 0, "the route calls the module");
  assert.ok(
    budgetAt < moduleAt,
    "budget gate must run before the module — the voice path pays for a transcription before the gateway backstop can refuse",
  );
});

test("draft-invoice runs outside the per-request transaction", () => {
  const appSrc = src("app.ts");
  const setStart = appSrc.indexOf("NO_CONTEXT_ROUTES = new Set(");
  assert.ok(setStart >= 0);
  const setEnd = appSrc.indexOf("])", setStart);
  assert.ok(
    appSrc
      .slice(setStart, setEnd)
      .includes('"POST /api/clerk/draft-invoice"'),
    "two sequential provider calls (transcription + inference) must not hold a pooled connection under the 30s request-transaction cap",
  );
});

// ---- Client-facing Ask (SEC-03) ---------------------------------------------
// clerk.ask was widened to client_user for the Ask surface ONLY. The wall
// keeping firm-wide facts from a client is now split across three places
// that no single module test sees together: the capability grant, the ask
// route passing the client posture into the module, and the digest route's
// explicit client refusal. Each gets a tripwire.

test("client_user holds clerk.ask (Ask) but never clerk.use (review)", () => {
  assert.ok(
    ROLE_CAPABILITIES.client_user.includes("clerk.ask"),
    "the client Ask surface needs the capability",
  );
  assert.ok(
    !ROLE_CAPABILITIES.client_user.includes("clerk.use"),
    "review/decide must stay operator-only",
  );
});

test("the ask route passes the principal-derived client posture into the module", () => {
  const block = routeBlock(src("routes/clerk.ts"), "/clerk/ask");
  assert.ok(
    block.includes('clientScoped: req.principal.role === "client_user"'),
    "askClerk must learn it is serving a client from the PRINCIPAL",
  );
  assert.ok(
    block.includes("clientPartyId: clientPartyScope(req.principal)"),
    "the forced party scope must come from the principal, never the body",
  );
  const budgetAt = block.indexOf("assertFirmClerkBudget");
  const moduleAt = block.indexOf("askClerk(");
  assert.ok(
    budgetAt >= 0 && moduleAt >= 0 && budgetAt < moduleAt,
    "a client's Ask spends the firm budget exactly like staff Ask — the pre-check must run before the module",
  );
});

test("the digest route refuses client_user despite the shared capability", () => {
  const block = routeBlock(src("routes/clerk.ts"), "/clerk/digest");
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.ask")'),
    "the digest keeps its clerk.ask gate for firm principals",
  );
  const guardAt = block.indexOf('req.principal.role === "client_user"');
  const readAt = block.indexOf("latestDigestForFirm(");
  assert.ok(
    guardAt >= 0,
    "the digest is firm-internal: client_user must be refused explicitly — the capability was widened for Ask, not for this",
  );
  assert.ok(
    readAt >= 0 && guardAt < readAt,
    "the client refusal must run before the digest is read",
  );
  assert.ok(
    block.slice(guardAt, readAt).includes("403"),
    "the refusal must be a 403, not a silent empty answer",
  );
});

test("bulk approval is operator-gated and runs inside the request transaction", () => {
  const block = routeBlock(src("routes/clerk.ts"), "/clerk/cases/bulk-approve");
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.use")'),
    "bulk approval is a review decision — operator-only like the single endpoint",
  );
  const appSrc = src("app.ts");
  const setStart = appSrc.indexOf("NO_CONTEXT_ROUTES = new Set(");
  const setEnd = appSrc.indexOf("])", setStart);
  assert.ok(
    !appSrc.slice(setStart, setEnd).includes("bulk-approve"),
    "bounded DB-only work belongs inside the ordinary request transaction — no model call happens here",
  );
});
