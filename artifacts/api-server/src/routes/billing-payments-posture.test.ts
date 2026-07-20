import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Route-posture tripwires for the payment collection seam (the
// clerk-route-posture.test.ts idiom): these invariants live in route wiring
// no module test reaches, yet reverting any of them silently breaks the
// rail's security or durability posture while the suite stays green:
//
//  - the confirmation webhook is a machine rail: it must be reachable
//    without a session (PUBLIC_PATHS) — but ONLY because the route itself
//    fails closed (404) until PAYMENT_WEBHOOK_TOKEN is configured;
//  - it must skip the buffered request transaction (NO_CONTEXT_ROUTES) and
//    the module must commit CAS + audit in its own short bypass transaction,
//    so the 202 is never sent for an uncommitted settle and appendAudit's
//    GLOBAL advisory lock is held per-settle only;
//  - the contract routes carry the billing statement's exact audience
//    (console.portfolio.read + firm scope) — the firm that sees the bill is
//    the firm that pays it.

const src = (rel: string): string =>
  readFileSync(join(import.meta.dirname, "..", rel), "utf8");

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`"${path}"`);
  assert.ok(start >= 0, `route ${path} exists`);
  const next = source.indexOf("router.", source.indexOf("=>", start));
  return source.slice(start, next === -1 ? undefined : next);
}

test("the confirmation webhook is public, and ONLY because it fails closed", () => {
  const principalSrc = src("middleware/principal.ts");
  const setStart = principalSrc.indexOf("PUBLIC_PATHS = new Set(");
  assert.ok(setStart >= 0);
  const set = principalSrc.slice(setStart, principalSrc.indexOf("])", setStart));
  assert.ok(
    set.includes('"/api/billing/payments/confirm"'),
    "the provider webhook has no session — the shared secret is the credential",
  );

  const block = routeBlock(
    src("routes/billing-payments.ts"),
    "/billing/payments/confirm",
  );
  const darkAt = block.indexOf("PAYMENT_WEBHOOK_TOKEN");
  const compareAt = block.indexOf("opTokenAllows");
  const settleAt = block.indexOf("confirmPaymentIntent(");
  assert.ok(
    darkAt >= 0 && block.includes("404"),
    "unset PAYMENT_WEBHOOK_TOKEN must keep the rail dark (404), the inbound-rail fail-closed posture — never open-when-unset",
  );
  assert.ok(
    compareAt > darkAt,
    "the constant-time token compare guards everything after the dark check",
  );
  assert.ok(
    settleAt > compareAt,
    "nothing settles before the token has been verified",
  );
});

test("the webhook skips the request transaction; the module owns its commit", () => {
  const appSrc = src("app.ts");
  const setStart = appSrc.indexOf("NO_CONTEXT_ROUTES = new Set(");
  assert.ok(setStart >= 0);
  const set = appSrc.slice(setStart, appSrc.indexOf("])", setStart));
  assert.ok(
    set.includes('"POST /api/billing/payments/confirm"'),
    "the settle must not ride the buffered request transaction — the module commits durably before the 202, and the global audit lock is held per-settle only",
  );
  const moduleSrc = src("modules/billing/payments.ts");
  const confirmAt = moduleSrc.indexOf("export async function confirmPaymentIntent");
  assert.ok(confirmAt >= 0);
  assert.ok(
    moduleSrc.slice(confirmAt).includes("runInBypassContext("),
    "with the route NO_CONTEXT, confirmPaymentIntent must open its own short bypass transaction (the machine caller has no tenant) or CAS + audit lose their atomic commit",
  );
});

test("the contract routes keep the billing statement's audience", () => {
  const routesSrc = src("routes/billing-payments.ts");
  for (const path of ["/billing/payments"]) {
    const block = routeBlock(routesSrc, path);
    assert.ok(
      block.includes('assertCan(req.principal, "console.portfolio.read")'),
      `${path} must gate on console.portfolio.read like GET /billing/statement`,
    );
    assert.ok(
      block.includes("requireFirmScope(req.principal)"),
      `${path} must resolve the firm from the principal, never the body`,
    );
  }
  // The GET registration appears after the POST; check it separately.
  const getStart = routesSrc.indexOf('router.get("/billing/payments"');
  assert.ok(getStart >= 0, "the list route exists");
  const getBlock = routesSrc.slice(
    getStart,
    routesSrc.indexOf("router.", getStart + 12),
  );
  assert.ok(
    getBlock.includes('assertCan(req.principal, "console.portfolio.read")') &&
      getBlock.includes("requireFirmScope(req.principal)"),
    "the list carries the same gates",
  );
});

test("the amount is computed server-side, never read from the request", () => {
  const moduleSrc = src("modules/billing/payments.ts");
  const createAt = moduleSrc.indexOf("export async function createPaymentIntent");
  const feeAt = moduleSrc.indexOf("computeBillingStatement(", createAt);
  const insertAt = moduleSrc.indexOf(".insert(paymentIntentsTable)", createAt);
  assert.ok(
    createAt >= 0 && feeAt > createAt && insertAt > feeAt,
    "the intent's amount must come from the billing-statement fee core before any row is written — a client-priced bill is the vulnerability this seam exists to prevent",
  );
});
