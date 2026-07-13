// The user journeys that prove MeridianIQ's surfaces against a freshly seeded
// database: portal auth, the operator's Compliance Desk, firm admin tooling,
// the auditor's read-only boundary, consent, and the credit-note lifecycle.
// Journeys restore what they mutate (flags, consent, passwords) so the suite
// reruns cleanly on the same seed.

const DEMO_PASSWORD = "meridian2027";

export async function runJourneys(page, BASE, check) {
  const signIn = async (demoTestId, waitUrl) => {
    await page.goto(BASE + "/login", { waitUntil: "networkidle" });
    await page.getByTestId(demoTestId).click();
    await page.waitForURL(waitUrl, { timeout: 20000 });
  };
  const signOutFromApp = async () => {
    await page.getByTestId("button-sign-out").first().click();
    await page.waitForURL(BASE + "/login");
    await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
  };

  // ---------- public landing + portal ----------
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

  // ---------- operator: Compliance Desk ----------
  await signIn("button-demo-ops", "**/console/operator-queue");
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

  await signOutFromApp();

  // ---------- firm admin: advisory ----------
  await signIn("button-demo-demo.admin", "**/console/");
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
  await signOutFromApp();

  // ---------- auditor: read-only boundary ----------
  await signIn("button-demo-audit", "**/console/audit");
  await page.waitForSelector('[data-testid="card-chain-valid"]', { timeout: 15000 });
  await page.getByTestId("nav-operator-queue").first().click();
  await page.waitForSelector('[data-testid^="card-case-"]', { timeout: 10000 });
  check(
    "auditor queue is read-only",
    (await page.locator('[data-testid^="button-claim-"]').count()) === 0,
  );
  await signOutFromApp();

  // ---------- SME owner: consent round trip ----------
  await signIn("button-demo-owner", "**/app/**");
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
  await signOutFromApp();

  // ---------- SME staff: credit note credits its original ----------
  await signIn("button-demo-demo.staff", "**/app/**");
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
    let credited = false;
    for (let i = 0; i < 10 && !credited; i++) {
      await page.waitForTimeout(1500);
      const r = await page.request.get(BASE + `/api/invoices/${target.id}`);
      credited = (await r.json()).invoice.status === "credited";
    }
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
  let narrowed = false;
  for (let i = 0; i < 10 && !narrowed; i++) {
    await page.waitForTimeout(700);
    narrowed =
      (await page.locator("text=INV-1002").count()) > 0 &&
      (await page.locator("text=INV-1001").count()) === 0;
  }
  check("server-side search narrows the invoice list", narrowed);

  // A draft can be created through the form — when the signed-in client can
  // see buyer parties. The demo seed engages only client parties, so the
  // seeded world legitimately shows the "No customers yet" state; in that
  // case assert the empty state renders and create the draft via the same
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
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      await page.waitForTimeout(700);
      found = (await page.locator(`text=${draftNumber}`).count()) > 0;
    }
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

  // ---------- change password round trip (restores the demo password) ----------
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
