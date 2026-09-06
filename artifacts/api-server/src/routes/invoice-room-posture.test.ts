import { test } from "node:test";
import assert from "node:assert/strict";
import { routeBlock, setBlock, src } from "../test-helpers/source-pins.ts";

const PUBLIC_BROWSER_PATHS = [
  "/api/public/invoice-room/exchange",
  "/api/public/invoice-room",
  "/api/public/invoice-room/otp",
  "/api/public/invoice-room/verify",
  "/api/public/invoice-room/respond",
  "/api/public/invoice-room/payment-reports",
  "/api/public/invoice-room/payment-link",
  "/api/public/invoice-room/claim",
  "/api/public/invoice-room/pdf",
];

test("every Invoice Room browser route is public only behind its opaque credential", () => {
  const publicPaths = setBlock(
    src("middleware/principal.ts"),
    "PUBLIC_PATHS = new Set(",
  );
  for (const path of PUBLIC_BROWSER_PATHS) {
    assert.ok(
      publicPaths.includes(`"${path}"`),
      `${path} must not require a platform session`,
    );
  }
  const routeSource = src("routes/invoice-room.ts");
  assert.ok(routeSource.includes("INVOICE_ROOM_COOKIE"));
  assert.ok(routeSource.includes("httpOnly: true"));
  assert.ok(routeSource.includes('path: "/api/public/invoice-room"'));
  assert.ok(
    routeSource.includes('"Cache-Control", "private, no-store, max-age=0"'),
  );
  assert.ok(
    routeSource.includes('"X-Robots-Tag", "noindex, nofollow, noarchive"'),
  );
});

test("browser writes leave the ambient transaction but retain CSRF and raw-pool throttles", () => {
  const noContext = setBlock(src("middleware/request-policy.ts"), "NO_CONTEXT_ROUTES = new Set(");
  for (const path of PUBLIC_BROWSER_PATHS.filter(
    (path) => !path.endsWith("/pdf") && path !== "/api/public/invoice-room",
  )) {
    assert.ok(
      noContext.includes(`"POST ${path}"`),
      `${path} must own its short transaction`,
    );
  }
  const routeSource = src("routes/invoice-room.ts");
  assert.ok(routeSource.includes("publicThrottle(req, res"));
  assert.ok(routeSource.includes("invoice-room-otp-send:"));
  assert.ok(routeSource.includes("invoice-room-payment-link:"));
  assert.ok(routeSource.includes("invoice-room-claim:"));
  const machinePaths = setBlock(
    src("middleware/principal.ts"),
    "MACHINE_PATHS = new Set(",
  );
  assert.ok(
    !machinePaths.includes('"/api/public/invoice-room/respond"'),
    "browser mutations stay under the custom-header CSRF boundary",
  );
});

test("the payment callback is public only because it fails closed before lookup", () => {
  const publicPaths = setBlock(
    src("middleware/principal.ts"),
    "PUBLIC_PATHS = new Set(",
  );
  assert.ok(publicPaths.includes('"/api/invoice-room/payments/confirm"'));
  const block = routeBlock(
    src("routes/invoice-room.ts"),
    "/invoice-room/payments/confirm",
  );
  const ringAt = block.indexOf('railKeyRing("INVOICE_PAYMENT_WEBHOOK_TOKEN")');
  const darkAt = block.indexOf("404");
  const authAt = block.indexOf("authenticateOpRequest");
  const settleAt = block.indexOf("confirmInvoiceRoomPayment");
  assert.ok(
    ringAt >= 0 && darkAt > ringAt && authAt > darkAt && settleAt > authAt,
  );
});

test("share credentials are fragment-only and public actions verify contact identity", () => {
  const security = src("modules/invoice-room/security.ts");
  assert.ok(security.includes("url.hash ="));
  assert.ok(!security.includes("searchParams.set"));
  const service = src("modules/invoice-room/service.ts");
  for (const fn of [
    "respondInInvoiceRoom",
    "reportInvoiceRoomPayment",
    "createInvoiceRoomPaymentLink",
    "claimInvoiceRoomAccount",
  ]) {
    const at = service.indexOf(`export async function ${fn}`);
    assert.ok(at >= 0, `${fn} exists`);
    assert.ok(
      service.slice(at, at + 2_500).includes("requireVerified: true"),
      `${fn} must require OTP-verified room access`,
    );
  }
});

test("OTP budgets are keyed per room as well as per session, and reminders respect the flag (R105 review)", () => {
  const routeSource = src("routes/invoice-room.ts");
  const otp = routeBlock(routeSource, "/public/invoice-room/otp");
  const verify = routeBlock(routeSource, "/public/invoice-room/verify");
  assert.ok(
    otp.includes("invoice-room-otp-send-share:${shareId}"),
    "OTP sends are budgeted per room across sessions",
  );
  assert.ok(
    verify.includes("invoice-room-otp-share:${shareId}"),
    "OTP verification is budgeted per room across sessions",
  );
  assert.ok(
    verify.includes("for (const key of throttleKeys) await clearActionFailures(key)"),
    "a successful verification clears both budgets",
  );
  const service = src("modules/invoice-room/service.ts");
  assert.ok(
    service.includes('isFeatureEnabled("invoice_room", share.firmId)') &&
      service.indexOf("sweepInvoiceRoomReminders") <
        service.lastIndexOf('isFeatureEnabled("invoice_room", share.firmId)'),
    "the reminder sweep skips firms whose invoice_room flag is dark",
  );
  assert.ok(
    service.includes("assertClientPartyScope(principal, invoice.supplierPartyId)"),
    "supplier scope uses the shared SEC-03 helper",
  );
});
