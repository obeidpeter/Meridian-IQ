// Role smoke journeys: the public portal, the operator's Compliance Desk,
// firm-admin advisory tooling, the auditor's read-only boundary, the SME
// owner's consent round trip, and the buyer TOTP enrolment lifecycle.
import { totpStep, totpCodeAtStep } from "../totp.mjs";
import { DEMO_PASSWORD, signIn, signOutFromApp } from "./shared.mjs";

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

  // Control centre activation evidence + audit evidence
  await page.getByTestId("nav-control-centre").click();
  await page.waitForSelector('[data-testid="gate-time-to-stamp"]', { timeout: 10000 });
  check("control centre activation evidence renders", true);
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

// ---------- buyer finance: TOTP enrolment lifecycle ----------
// Enrol → challenge sign-in → disable, computing live RFC 6238 codes in the
// harness from the base32 secret the enrolment card shows on screen. Uses
// finance@zenithretail.example — the one seeded demo account no other journey
// signs in as — and restores it to single-factor (and signed out) before
// finishing, so the suite reruns cleanly on the same seed.
async function journeyTotp(page, BASE, check) {
  const EMAIL = "finance@zenithretail.example";

  // The server burns each accepted code's 30s step (single-use, RFC 6238
  // §5.2) and matches within a ±1-step window. Track the highest step burned
  // and mint every next code at a strictly later step — waiting out a step
  // boundary when the suite outruns the clock.
  let burnedStep = -1;
  const freshCode = async (secret) => {
    while (burnedStep > totpStep()) await page.waitForTimeout(1000);
    const step = Math.max(totpStep(), burnedStep + 1);
    burnedStep = step;
    return totpCodeAtStep(secret, step);
  };

  // Password-only sign-in works today and lands the buyer workspace.
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByTestId("input-email").fill(EMAIL);
  await page.getByTestId("input-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-sign-in").click();
  await page.waitForURL("**/buyer/**", { timeout: 20000 });

  // The portal's signed-in panel carries the security card.
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="card-totp"]', { timeout: 10000 });
  check(
    "security card shows two-factor off for a fresh account",
    await page.getByTestId("button-totp-enable").isVisible(),
  );

  // Enable: secret, otpauth URI and the 8 recovery codes are shown once.
  await page.getByTestId("button-totp-enable").click();
  await page.waitForSelector('[data-testid="text-totp-secret"]', {
    timeout: 10000,
  });
  const secret = (await page.getByTestId("text-totp-secret").innerText()).trim();
  check(
    "enrolment reveals a base32 secret",
    /^[A-Z2-7]{16,}$/.test(secret),
  );
  check(
    "eight single-use recovery codes are shown",
    (await page.locator('[data-testid="list-recovery-codes"] li').count()) === 8,
  );

  // Activate with a live code computed in the harness from that secret.
  await page.getByTestId("input-totp-activate").fill(await freshCode(secret));
  await page.getByTestId("button-totp-activate").click();
  await page.waitForSelector('[data-testid="text-totp-enabled"]', {
    timeout: 10000,
  });
  check(
    "live code activates two-factor; the panel survives the re-issued cookie",
    (await page.getByTestId("text-recovery-remaining").innerText()).includes("8"),
  );

  // Activation bumped the session epoch and re-issued THIS session's cookie —
  // signing out through the same panel proves the session carried over.
  await signOutFromApp(page, BASE);

  // An enrolled account's password now earns a challenge, not a session.
  await page.getByTestId("input-email").fill(EMAIL);
  await page.getByTestId("input-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-sign-in").click();
  await page.waitForSelector('[data-testid="input-totp-code"]', {
    timeout: 10000,
  });
  check("enrolled sign-in demands the second factor", true);

  // A wrong code shows the uniform error and allows retry. Pick a code that
  // is provably invalid across the server's whole ±1-step window.
  const windowCodes = [totpStep() - 1, totpStep(), totpStep() + 1].map((s) =>
    totpCodeAtStep(secret, s),
  );
  const wrongCode = windowCodes.includes("000000") ? "999999" : "000000";
  await page.getByTestId("input-totp-code").fill(wrongCode);
  await page.getByTestId("button-totp-verify").click();
  await page.waitForSelector('[data-testid="text-totp-error"]', {
    timeout: 10000,
  });
  check("wrong code shows the uniform challenge error", true);

  // A fresh code completes the challenge into the buyer workspace.
  await page.getByTestId("input-totp-code").fill(await freshCode(secret));
  await page.getByTestId("button-totp-verify").click();
  await page.waitForURL("**/buyer/**", { timeout: 20000 });
  check("fresh code completes the challenge into the workspace", true);

  // Disable requires the password AND a live code, then restores single-factor.
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="text-totp-enabled"]', {
    timeout: 10000,
  });
  await page.getByTestId("button-totp-disable-show").click();
  await page.getByTestId("input-totp-disable-password").fill(DEMO_PASSWORD);
  await page.getByTestId("input-totp-disable-code").fill(await freshCode(secret));
  await page.getByTestId("button-totp-disable").click();
  await page.waitForSelector('[data-testid="button-totp-enable"]', {
    timeout: 10000,
  });
  check("password + code disables two-factor", true);

  // Single-step sign-in is restored (the account is back to its seeded state).
  await signOutFromApp(page, BASE);
  await page.getByTestId("input-email").fill(EMAIL);
  await page.getByTestId("input-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-sign-in").click();
  await page.waitForURL("**/buyer/**", { timeout: 20000 });
  check("single-step sign-in restored after disable", true);

  // Leave nothing signed in for the journeys that follow.
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await signOutFromApp(page, BASE);
}

export { journeyPortalAuth, journeyOperatorDesk, journeyFirmAdminAdvisory, journeyAuditorReadOnly, journeyOwnerConsent, journeyTotp };
