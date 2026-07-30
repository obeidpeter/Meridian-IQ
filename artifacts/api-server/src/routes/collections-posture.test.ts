import { test } from "node:test";
import assert from "node:assert/strict";
import { routeBlock, setBlock, src } from "../test-helpers/source-pins.ts";

// Route-posture tripwires for the collection-account seam (the
// billing-payments-posture.test.ts idiom): these invariants live in route
// wiring no module test reaches, yet reverting any of them silently breaks
// the rail's security or durability posture while the suite stays green:
//
//  - the inbound webhook is a machine rail: it must be reachable without a
//    session (PUBLIC_PATHS) — but ONLY because the route itself fails closed
//    (404) until COLLECTION_WEBHOOK_TOKEN is configured;
//  - it must skip the buffered request transaction (NO_CONTEXT_ROUTES) and
//    the module must commit event + CAS + audit in its own short bypass
//    transaction, so the 202 is never sent for an uncommitted settle and
//    appendAudit's GLOBAL advisory lock is held per-settle only;
//  - the contract routes carry the statement-connections audience exactly
//    (statement.write + firm scope) — the firm staff who wire a client's
//    bank feeds are the ones who wire its collection account.

test("the inbound webhook is public, and ONLY because it fails closed", () => {
  const set = setBlock(src("middleware/principal.ts"), "PUBLIC_PATHS = new Set(");
  assert.ok(
    set.includes('"/api/collections/inbound"'),
    "the provider webhook has no session — the shared secret is the credential",
  );

  const block = routeBlock(
    src("routes/collections.ts"),
    "/collections/inbound",
  );
  const darkAt = block.indexOf("COLLECTION_WEBHOOK_TOKEN");
  const compareAt = block.indexOf("opTokenAllows");
  const settleAt = block.indexOf("recordInboundCollection(");
  assert.ok(
    darkAt >= 0 && block.includes("404"),
    "unset COLLECTION_WEBHOOK_TOKEN must keep the rail dark (404), the inbound-rail fail-closed posture — never open-when-unset",
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
  const set = setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(");
  assert.ok(
    set.includes('"POST /api/collections/inbound"'),
    "the settle must not ride the buffered request transaction — the module commits durably before the 202, and the global audit lock is held per-settle only",
  );
  const moduleSrc = src("modules/collections/service.ts");
  const recordAt = moduleSrc.indexOf(
    "export async function recordInboundCollection",
  );
  assert.ok(recordAt >= 0);
  assert.ok(
    moduleSrc.slice(recordAt).includes("runInBypassContext("),
    "with the route NO_CONTEXT, recordInboundCollection must open its own short bypass transaction (the machine caller has no tenant) or event + CAS + audit lose their atomic commit",
  );
});

test("the contract routes keep the statement-connections audience", () => {
  const routesSrc = src("routes/collections.ts");
  for (const path of ["/collection-accounts"]) {
    const block = routeBlock(routesSrc, path);
    assert.ok(
      block.includes('assertCan(req.principal, "statement.write")'),
      `${path} must gate on statement.write like the statement-connections routes`,
    );
    assert.ok(
      block.includes("requireFirmScope(req.principal)"),
      `${path} must resolve the firm from the principal, never the body`,
    );
  }
  // The POST registration appears after the GET; check it separately.
  const postStart = routesSrc.indexOf('router.post("/collection-accounts"');
  assert.ok(postStart >= 0, "the create route exists");
  const postBlock = routesSrc.slice(
    postStart,
    routesSrc.indexOf("router.", postStart + 12),
  );
  assert.ok(
    postBlock.includes('assertCan(req.principal, "statement.write")') &&
      postBlock.includes("requireFirmScope(req.principal)"),
    "the create carries the same gates",
  );
  // Deactivate is id-scoped: capability plus a same-tenant assertion on the
  // loaded row (the statement-connections :id/sync idiom).
  const deactStart = routesSrc.indexOf(
    '"/collection-accounts/:id/deactivate"',
  );
  assert.ok(deactStart >= 0, "the deactivate route exists");
  const deactBlock = routesSrc.slice(
    deactStart,
    routesSrc.indexOf("router.", deactStart),
  );
  assert.ok(
    deactBlock.includes('assertCan(req.principal, "statement.write")') &&
      deactBlock.includes("assertSameTenant(req.principal, account.firmId)"),
    "deactivate carries the capability and the same-tenant wall",
  );
});
