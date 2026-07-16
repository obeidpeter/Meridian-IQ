import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Route-posture tripwires. These invariants live in route wiring that no
// module test can reach (there is no HTTP-level harness; the e2e journeys
// exercise happy paths only), yet reverting any of them breaks a shipped
// flow while the whole suite stays green:
//
//  - the SME "Fix with Clerk" card depends on /clerk/explain-failure being
//    reachable with clerk.capture (client_users do NOT hold clerk.ask);
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
