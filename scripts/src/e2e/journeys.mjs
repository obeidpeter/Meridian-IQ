// The user journeys that prove MeridianIQ's surfaces against a freshly seeded
// database: portal auth, the operator's Compliance Desk, firm admin tooling,
// the auditor's read-only boundary, consent, and the credit-note lifecycle.
// Journeys restore what they mutate (flags, consent, passwords) so the suite
// reruns cleanly on the same seed.

const DEMO_PASSWORD = "meridian2027";

async function signIn(page, BASE, demoTestId, waitUrl) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByTestId(demoTestId).click();
  await page.waitForURL(waitUrl, { timeout: 20000 });
}

async function signOutFromApp(page, BASE) {
  await page.getByTestId("button-sign-out").first().click();
  await page.waitForURL(BASE + "/login");
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
}

// Poll a probe until it reports true. The delay runs BEFORE each attempt —
// the search probes rely on it for the debounced input to settle.
async function pollUntil(fn, { tries = 10, delayMs = 700, page }) {
  let ok = false;
  for (let i = 0; i < tries && !ok; i++) {
    await page.waitForTimeout(delayMs);
    ok = await fn();
  }
  return ok;
}

// ---------- public landing + portal ----------
async function journeyPortalAuth(page, BASE, check) {
  // Clickjacking defence (SEC-02): the served frontend must carry a CSP
  // frame-ancestors allowlist so an attacker origin cannot frame the
  // authenticated app (the session cookie is SameSite=None for the preview
  // iframe, which re-opens framing without this header).
  const rootResp = await page.request.get(BASE + "/");
  const csp = rootResp.headers()["content-security-policy"] ?? "";
  check(
    "frontend sets a CSP frame-ancestors allowlist",
    csp.includes("frame-ancestors") && !csp.includes("frame-ancestors *"),
  );

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  check(
    "landing page links to the login portal",
    await page.getByTestId("link-hero-login").isVisible(),
  );
  await page.getByTestId("link-hero-login").click();
  await page.waitForURL(BASE + "/login");
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
  check("portal shows sign-in panel", await page.getByTestId("input-email").isVisible());

  await page.getByTestId("input-email").fill("ops@meridianiq.example");
  await page.getByTestId("input-password").fill("wrong-password");
  await page.getByTestId("button-sign-in").click();
  await page.waitForSelector('[data-testid="text-login-error"]');
  check(
    "bad password shows uniform error",
    (await page.getByTestId("text-login-error").innerText()).includes("Invalid email or password"),
  );

  // Login throttling (SEC-02): probe a throwaway identity via the API.
  let throttled = false;
  for (let i = 0; i < 6; i++) {
    const r = await page.request.post(BASE + "/api/auth/login", {
      data: { email: "probe@nowhere.example", password: "x".repeat(8) },
    });
    if (r.status() === 429) {
      throttled = true;
      break;
    }
  }
  check("login rate limit engages after repeated failures", throttled);
}

// ---------- operator: Compliance Desk ----------
async function journeyOperatorDesk(page, BASE, check) {
  await signIn(page, BASE, "button-demo-ops", "**/console/operator-queue");
  await page.waitForSelector('[data-testid="text-page-title"]');
  check(
    "operator lands on the work queue",
    (await page.getByTestId("text-page-title").innerText()).includes("Operator work queue"),
  );
  await page.waitForSelector("text=Client escalation", { timeout: 10000 });
  check("queue card carries client escalation context", true);
  check(
    "operator nav hides firm-only pages",
    (await page.getByTestId("nav-portfolio").count()) === 0,
  );

  // Error catalogue renders with entries
  await page.getByTestId("nav-error-catalogue").click();
  await page.waitForSelector('[data-testid="entry-MBS_INVALID_TIN"]', { timeout: 10000 });
  check("error catalogue lists entries", true);

  // Feature flag round trip
  await page.getByTestId("nav-feature-flags").click();
  await page.waitForSelector('[data-testid="switch-reconciliation"]');
  await page.getByTestId("switch-reconciliation").click();
  await page.waitForSelector("text=reconciliation enabled", { timeout: 8000 });
  await page.getByTestId("switch-reconciliation").click();
  await page.waitForSelector("text=reconciliation disabled", { timeout: 8000 });
  check("feature flag toggles round-trip", true);

  // Platform ops: rails + messages section render
  await page.getByTestId("nav-platform-ops").click();
  await page.waitForSelector('[data-testid="card-rails"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="card-messages"]', { timeout: 10000 });
  check("platform ops renders rails and message log", true);

  // Gate metrics + audit evidence
  await page.getByTestId("nav-gate-metrics").click();
  await page.waitForSelector('[data-testid="gate-time-to-stamp"]', { timeout: 10000 });
  check("gate metrics render", true);
  await page.getByTestId("nav-audit-&-evidence").click();
  await page.waitForSelector('[data-testid="card-chain-valid"]', { timeout: 10000 });
  check("audit chain verifies", true);

  // Party integrity workbench renders
  await page.getByTestId("nav-party-integrity").click();
  await page.waitForSelector('[data-testid="stat-parties"]', { timeout: 10000 });
  check("party workbench renders", true);

  await signOutFromApp(page, BASE);
}

// ---------- firm admin: advisory ----------
async function journeyFirmAdminAdvisory(page, BASE, check) {
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/");
  await page.waitForSelector('[data-testid="text-page-title"]');
  check(
    "admin lands on portfolio",
    (await page.getByTestId("text-page-title").innerText()).includes("Client portfolio"),
  );
  await page.getByTestId("nav-advisory").click();
  await page.getByTestId("tab-vat-risk").click();
  await page
    .getByTestId("input-vat-csv")
    .fill(
      "invoice number,supplier tin,irn,csid,invoice amount,vat amount\nT-1,20000000-0002,IRN-X,CSID-X,100000,7500",
    );
  await page.getByTestId("button-analyze-vat").click();
  await page.waitForSelector('[data-testid="stat-vat-at-risk"]', { timeout: 15000 });
  check("VAT-risk analysis produces a report", true);
  await signOutFromApp(page, BASE);
}

// ---------- auditor: read-only boundary ----------
async function journeyAuditorReadOnly(page, BASE, check) {
  await signIn(page, BASE, "button-demo-audit", "**/console/audit");
  await page.waitForSelector('[data-testid="card-chain-valid"]', { timeout: 15000 });
  await page.getByTestId("nav-operator-queue").first().click();
  await page.waitForSelector('[data-testid^="card-case-"]', { timeout: 10000 });
  check(
    "auditor queue is read-only",
    (await page.locator('[data-testid^="button-claim-"]').count()) === 0,
  );
  await signOutFromApp(page, BASE);
}

// ---------- SME owner: consent round trip ----------
async function journeyOwnerConsent(page, BASE, check) {
  await signIn(page, BASE, "button-demo-owner", "**/app/**");
  await page.goto(BASE + "/app/consent", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="consent-layer-1"]', { timeout: 10000 });
  check(
    "consent page: layer 3 dormant",
    (await page.locator('[data-testid="consent-layer-3"]').innerText()).includes(
      "Not yet available",
    ),
  );
  await page.getByTestId("button-grant-2").click();
  await page.waitForSelector('[data-testid="button-revoke-2"]', { timeout: 10000 });
  await page.getByTestId("button-revoke-2").click();
  await page.waitForSelector('[data-testid="button-grant-2"]', { timeout: 10000 });
  check("consent layer 2 grant/revoke round-trips", true);
  await signOutFromApp(page, BASE);
}

// ---------- SME staff: credit note + workflow smoke ----------
// Signs in as demo.staff and deliberately leaves that session signed in —
// journeyPasswordRoundTrip operates on it and must run immediately after.
async function journeyStaffCreditNoteAndWorkflow(page, BASE, check) {
  // ---------- SME staff: credit note credits its original ----------
  await signIn(page, BASE, "button-demo-demo.staff", "**/app/**");
  const invoicesResp = await page.request.get(BASE + "/api/invoices?status=stamped");
  const stamped = (await invoicesResp.json()).filter(
    (i) => i.supplierPartyId.startsWith("22222222") && i.kind === "invoice",
  );
  check("a stamped, consented invoice exists to credit", stamped.length > 0);
  if (stamped.length > 0) {
    const target = stamped[0];
    await page.goto(BASE + `/app/invoices/${target.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="button-credit-note"]', { timeout: 10000 });
    await page.getByTestId("button-credit-note").click();
    await page.getByTestId("input-adjust-reason").fill("E2E: goods returned.");
    await page.getByTestId("button-confirm-adjust").click();
    await page.waitForSelector(`text=Credit note CN-${target.invoiceNumber} submitted`, {
      timeout: 15000,
    });
    // the pipeline credits the original once the credit note stamps
    const credited = await pollUntil(
      async () => {
        const r = await page.request.get(BASE + `/api/invoices/${target.id}`);
        return (await r.json()).invoice.status === "credited";
      },
      { delayMs: 1500, page },
    );
    check("credit note credits its original (CORE-09)", credited);
  }

  // ---------- SME staff: dashboard, search, draft, exports (still signed in) ----------
  // Smoke for the workflow features: receivables card, server-side invoice
  // search, the invoice form, CSV exports and the version-skew banner. These
  // are the cross-layer checks unit tests structurally can't make — the real
  // bundle against the real contract over real cookies.

  // Dashboard renders its summary and the receivables card; the server and
  // bundle were built from the same contract, so the skew banner must be off.
  await page.goto(BASE + "/app/", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="text-page-title"]', { timeout: 15000 });
  await page.waitForSelector("text=Receivables", { timeout: 15000 });
  check("SME dashboard renders the receivables card", true);
  check(
    "no version-skew banner when server and bundle match",
    (await page.locator('[data-testid="banner-stale-server"]').count()) === 0,
  );

  // Invoice list: seeded rows render, and the search input round-trips a
  // server-side q (debounced, so poll until the narrowed list settles).
  await page.goto(BASE + "/app/invoices", { waitUntil: "networkidle" });
  await page.waitForSelector("text=INV-1001", { timeout: 15000 });
  check("invoice list renders the seeded book", true);
  await page.locator("#invoice-search").fill("INV-1002");
  const narrowed = await pollUntil(
    async () =>
      (await page.locator("text=INV-1002").count()) > 0 &&
      (await page.locator("text=INV-1001").count()) === 0,
    { page },
  );
  check("server-side search narrows the invoice list", narrowed);

  // A draft can be created through the form — when the signed-in client can
  // see buyer parties. Since the new-customer gap closed (firm staff see
  // invoice-referenced buyers), the seeded world takes this branch; the
  // no-customers fallback below stays for seeds without visible buyers —
  // there, assert the empty state renders and create the draft via the same
  // session's API instead, then verify it surfaces in the list UI.
  const draftNumber = `E2E-${Date.now()}`;
  await page.goto(BASE + "/app/invoices/new", { waitUntil: "networkidle" });
  await page.waitForSelector("#buyer-select", { timeout: 15000 });
  const buyersAvailable =
    (await page.locator('[data-testid="text-no-buyers"]').count()) === 0;
  if (buyersAvailable) {
    await page.getByLabel("Invoice number").fill(draftNumber);
    await page.locator("#buyer-select").click();
    await page.getByRole("option").first().click();
    await page.locator("#line-0-description").fill("E2E smoke goods");
    await page.locator("#line-0-quantity").fill("2");
    await page.locator("#line-0-unit-price").fill("1500");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await page.waitForSelector(`text=${draftNumber}`, { timeout: 15000 });
    check("invoice form creates a draft", true);
  } else {
    check(
      "invoice form shows the no-customers state for the seeded client",
      true,
    );
    const parties = await (await page.request.get(BASE + "/api/parties")).json();
    const created = await page.request.post(BASE + "/api/invoices", {
      data: {
        supplierPartyId: parties[0].id,
        buyerPartyId: parties[0].id,
        invoiceNumber: draftNumber,
        issueDate: new Date().toISOString().slice(0, 10),
        lines: [
          {
            description: "E2E smoke goods",
            quantity: "2",
            unitPrice: "1500",
            vatRate: "0.075",
          },
        ],
      },
      headers: { "x-meridian-csrf": "1" },
    });
    check("draft created via the session API", created.status() === 201);
    await page.goto(BASE + "/app/invoices", { waitUntil: "networkidle" });
    await page.locator("#invoice-search").fill(draftNumber);
    const found = await pollUntil(
      async () => (await page.locator(`text=${draftNumber}`).count()) > 0,
      { page },
    );
    check("fresh draft surfaces through list search", found);
  }

  // CSV exports ride the same session cookie.
  const invCsv = await page.request.get(BASE + "/api/invoices/export");
  const invCsvBody = await invCsv.text();
  check(
    "invoice CSV export delivers the book",
    invCsv.status() === 200 &&
      (invCsv.headers()["content-type"] ?? "").includes("text/csv") &&
      invCsvBody.includes("INV-1001"),
  );
  const meResp = await page.request.get(BASE + "/api/me");
  const me = await meResp.json();
  const recCsv = await page.request.get(
    BASE + `/api/dashboard/receivables/export?clientPartyId=${me.clientPartyId}`,
  );
  check(
    "receivables CSV export responds for the signed-in client",
    recCsv.status() === 200 &&
      (recCsv.headers()["content-type"] ?? "").includes("text/csv"),
  );

  // Bulk-submit entry point: the confirmation dialog opens and cancels
  // cleanly (the destructive path itself is covered by API tests).
  await page.goto(BASE + "/app/invoices", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="button-bulk-submit"]', { timeout: 15000 });
  await page.getByTestId("button-bulk-submit").click();
  await page.waitForSelector("text=Submit all pending drafts?", { timeout: 10000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  check("bulk-submit confirmation opens and cancels", true);

  // Recurring invoices page renders with its create entry point.
  await page.goto(BASE + "/app/recurring", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="button-new-recurring"]', {
    timeout: 15000,
  });
  check("recurring invoices page renders", true);
}

// ---------- change password round trip (restores the demo password) ----------
// Requires the demo.staff session left signed in by the previous journey (the
// change-password form acts on the current session), and must stay LAST: it
// temporarily changes demo.staff's password before restoring it.
async function journeyPasswordRoundTrip(page, BASE, check) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="button-show-change-password"]', {
    timeout: 10000,
  });
  await page.getByTestId("button-show-change-password").click();
  await page.getByTestId("input-current-password").fill(DEMO_PASSWORD);
  await page.getByTestId("input-new-password").fill("temp-password-1");
  await page.getByTestId("button-change-password").click();
  await page.waitForSelector('[data-testid="text-password-changed"]', { timeout: 10000 });
  const oldPw = await page.request.post(BASE + "/api/auth/login", {
    data: { email: "demo.staff@meridianiq.example", password: DEMO_PASSWORD },
  });
  check("old password rejected after change", oldPw.status() === 401);
  // restore
  await page.getByTestId("button-show-change-password").click();
  await page.getByTestId("input-current-password").fill("temp-password-1");
  await page.getByTestId("input-new-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-change-password").click();
  await page.waitForSelector('[data-testid="text-password-changed"]', { timeout: 10000 });
  check("password change round-trips (restored)", true);
}

// ---------- operator-issued password reset (restores the demo password) ------
// IDN-02 recovery loop end-to-end: an operator issues a one-time reset link,
// the landing page redeems it, the old password dies, and a second reset
// restores the demo password. Runs LAST for the same reason as the change-
// password journey: demo.staff's password is temporarily different.
async function journeyPasswordReset(page, BASE, check) {
  const STAFF = "demo.staff@meridianiq.example";

  // Sign in as the operator and issue a reset link for the staff account.
  await page.request.post(BASE + "/api/auth/login", {
    data: { email: "ops@meridianiq.example", password: DEMO_PASSWORD },
    headers: { "x-meridian-csrf": "1" },
  });
  const issued = await page.request.post(BASE + "/api/password-resets", {
    data: { email: STAFF },
    headers: { "x-meridian-csrf": "1" },
  });
  const issuedBody = issued.status() === 201 ? await issued.json() : null;
  check(
    "operator issues a one-time password reset link",
    issued.status() === 201 && !!issuedBody?.token,
  );

  // Redeem it through the landing reset page.
  await page.goto(BASE + `/reset-password?token=${issuedBody.token}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('[data-testid="input-reset-password"]', {
    timeout: 15000,
  });
  await page.getByTestId("input-reset-password").fill("reset-temp-pw-1");
  await page.getByTestId("input-reset-confirm").fill("reset-temp-pw-1");
  await page.getByTestId("button-set-password").click();
  await page.waitForSelector('[data-testid="card-reset-success"]', {
    timeout: 15000,
  });
  check("reset page sets the new password", true);

  const oldPw = await page.request.post(BASE + "/api/auth/login", {
    data: { email: STAFF, password: DEMO_PASSWORD },
  });
  check("old password rejected after reset", oldPw.status() === 401);
  const newPw = await page.request.post(BASE + "/api/auth/login", {
    data: { email: STAFF, password: "reset-temp-pw-1" },
  });
  check("new password signs in after reset", newPw.status() === 200);

  // The redeemed link is single-use.
  const replay = await page.request.post(BASE + "/api/auth/reset-password", {
    data: { token: issuedBody.token, password: "reset-temp-pw-2" },
    headers: { "x-meridian-csrf": "1" },
  });
  check("reset link is single-use", replay.status() === 400);

  // Restore the demo password via a second reset so reruns start clean.
  await page.request.post(BASE + "/api/auth/login", {
    data: { email: "ops@meridianiq.example", password: DEMO_PASSWORD },
    headers: { "x-meridian-csrf": "1" },
  });
  const restore = await page.request.post(BASE + "/api/password-resets", {
    data: { email: STAFF },
    headers: { "x-meridian-csrf": "1" },
  });
  const restoreBody = await restore.json();
  const restored = await page.request.post(BASE + "/api/auth/reset-password", {
    data: { token: restoreBody.token, password: DEMO_PASSWORD },
    headers: { "x-meridian-csrf": "1" },
  });
  check("second reset restores the demo password", restored.status() === 204);
}

export async function runJourneys(page, BASE, check) {
  await journeyPortalAuth(page, BASE, check);
  await journeyOperatorDesk(page, BASE, check);
  await journeyFirmAdminAdvisory(page, BASE, check);
  await journeyAuditorReadOnly(page, BASE, check);
  await journeyOwnerConsent(page, BASE, check);
  await journeyStaffCreditNoteAndWorkflow(page, BASE, check);
  await journeyPasswordRoundTrip(page, BASE, check);
  await journeyPasswordReset(page, BASE, check);
}
