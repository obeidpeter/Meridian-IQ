import { createHash, createHmac } from "node:crypto";
import { CSRF, commandHeaders } from "../../test-client.mjs";
// Shared spine of the e2e journeys: the demo credentials, the CSRF marker,
// the seeded demo-client ids, and the sign-in/api-session/poll helpers every
// journey group composes. Journey code lives in the sibling group files;
// index.mjs runs them in the load-bearing order (journeys mutate shared seed
// state, so the run order is part of the contract).

const DEMO_PASSWORD = "meridian-e2e-2027!";

const DEMO_EMAIL_BY_TEST_ID = {
  "button-demo-ops": "ops@meridianiq.example",
  "button-demo-demo.admin": "demo.admin@meridianiq.example",
  "button-demo-audit": "audit@meridianiq.example",
  "button-demo-owner": "owner@adaezefoods.example",
  "button-demo-demo.staff": "demo.staff@meridianiq.example",
  // Seeded WITHOUT any consent event: the first-landing capture journey.
  "button-demo-tunde": "owner@tundeprints.example",
};

// Every state-changing page.request call presents the CSRF marker header.

// The seeded demo client party. Journeys key list filters and API calls off
// the full id, and pattern-match "a demo-client invoice" off its first block.
const DEMO_CLIENT_PARTY_ID = "22222222-2222-4222-8222-222222222222";
const DEMO_CLIENT_PARTY_PREFIX = DEMO_CLIENT_PARTY_ID.slice(0, 8);

export { DEMO_PASSWORD, CSRF, DEMO_CLIENT_PARTY_ID, DEMO_CLIENT_PARTY_PREFIX };

export async function signIn(page, BASE, demoTestId, waitUrl) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  const email = DEMO_EMAIL_BY_TEST_ID[demoTestId];
  if (!email) throw new Error(`Unknown E2E identity ${demoTestId}`);
  await page.getByTestId("input-email").fill(email);
  await page.getByTestId("input-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-sign-in").click();
  await page.waitForURL(waitUrl, { timeout: 20000 });
}

export async function signOutFromApp(page, BASE) {
  await page.getByTestId("button-sign-out").first().click();
  await page.waitForURL(BASE + "/login");
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
}

// API-session sign-in with the demo password: page.request shares the browser
// context's cookie jar, so a later page.goto rides the same session. Drops any
// current session first (logout is a public, idempotent endpoint).
export async function apiLogin(page, BASE, email) {
  await apiLogout(page, BASE);
  const response = await page.request.post(BASE + "/api/auth/login", {
    data: { email, password: DEMO_PASSWORD },
    headers: CSRF,
  });
  if (response.status() !== 200)
    throw new Error(`Fixture login refused: ${response.status()} (${email})`);
}

export async function apiLogout(page, BASE) {
  const response = await page.request.post(BASE + "/api/auth/logout", {
    headers: CSRF,
  });
  if (!response.ok())
    throw new Error(`Fixture logout refused: ${response.status()}`);
}

// The one-line draft-invoice scaffold every journey probe shares: POST
// /api/invoices with a single line (vatRate defaults to the standard 7.5%),
// CSRF marker included. Returns the response status plus the created
// invoice's id — null unless the create answered 201 (the body is only
// parsed on 201, so a refusal costs nothing extra). whtCategory is optional
// (WHT Desk): set, it rides the POST body; unset, the field is omitted
// entirely — existing callers are untouched.
export async function createDraftInvoice(
  page,
  BASE,
  {
    supplierPartyId,
    buyerPartyId,
    invoiceNumber,
    issueDate,
    description,
    unitPrice,
    quantity = "1",
    vatRate = "0.075",
    whtCategory,
    idempotencyKey,
  },
) {
  const res = await page.request.post(BASE + "/api/invoices", {
    data: {
      supplierPartyId,
      buyerPartyId,
      invoiceNumber,
      issueDate,
      ...(whtCategory ? { whtCategory } : {}),
      lines: [{ description, quantity, unitPrice, vatRate }],
    },
    headers: commandHeaders(idempotencyKey),
  });
  return {
    status: res.status(),
    invoiceId:
      res.status() === 201 ? ((await res.json()).invoice?.id ?? null) : null,
  };
}

// Poll a probe until it reports true. The delay runs BEFORE each attempt —
// the search probes rely on it for the debounced input to settle.
// Sign a machine-rail request the way lib/op-token.ts verifies it (R100):
// `v1=` + hex HMAC-SHA256(secret, `${ts}.${METHOD}.${path}.${sha256hex(body)}`),
// with the key id and timestamp as headers. `path` is the full request path
// the server sees (e.g. /api/collections/inbound).
export function signOpRequest(key, { method, path, body = "", timestamp }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const digest = createHmac("sha256", key.secret)
    .update(`${ts}.${method.toUpperCase()}.${path}.${bodyHash}`)
    .digest("hex");
  return {
    "x-op-key-id": key.id,
    "x-op-timestamp": String(ts),
    "x-op-signature": `v1=${digest}`,
  };
}

export async function pollUntil(fn, { tries = 10, delayMs = 700, page }) {
  let ok = false;
  for (let i = 0; i < tries && !ok; i++) {
    await page.waitForTimeout(delayMs);
    ok = await fn();
  }
  return ok;
}
