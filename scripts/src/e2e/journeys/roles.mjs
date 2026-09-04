// Role smoke journeys: the public portal, the operator's Compliance Desk,
// firm-admin advisory tooling, the auditor's read-only boundary, the SME
// owner's consent round trip, and the buyer TOTP enrolment lifecycle.
import { totpStep, totpCodeAtStep } from "../totp.mjs";
import {
  CSRF,
  DEMO_PASSWORD,
  apiLogin,
  apiLogout,
  signIn,
  signOutFromApp,
} from "./shared.mjs";
import { checkPageAccessibility } from "../accessibility.mjs";

// ---------- public landing + portal ----------
// ---------- app shell (R69): workspace chip + flag-derived release badge ----------
// The header names the workspace the session is scoped to and shows the
// activation stage the server derived from the lit flags. Both are read
// from /me, so the check compares the rendered badge against the API's
// releaseTag rather than pinning a number the seed could change.
async function checkShell(
  page,
  BASE,
  check,
  { label, roleText, workspaceText, homeTestId },
) {
  const me = await (await page.request.get(BASE + "/api/me")).json();
  const badge = page.getByTestId("text-release-badge");
  const badgeText = (await badge.count()) ? await badge.innerText() : "";
  check(
    `${label}: release badge mirrors /me releaseTag (${me.releaseTag})`,
    /^R[0-4]$/.test(me.releaseTag ?? "") &&
      badgeText === `Release ${String(me.releaseTag).slice(1)}`,
  );
  const chip = page.getByTestId("text-workspace-chip");
  const chipText = (await chip.count()) ? await chip.innerText() : "";
  check(
    `${label}: workspace chip names the session's workspace`,
    chipText.length > 0 &&
      (workspaceText ? chipText.includes(workspaceText) : true) &&
      (me.workspaceName ? chipText.includes(me.workspaceName) : true),
  );
  // textContent, not innerText: the role text collapses below 80rem (the
  // default Playwright viewport is 1280px wide), and the check is about the
  // label the shell carries, not whether this viewport shows it.
  check(
    `${label}: header role reads "${roleText}"`,
    ((await page.getByTestId("text-role-context").textContent()) ?? "").trim() ===
      roleText,
  );
  if (homeTestId) {
    check(
      `${label}: sidebar home entry is ${homeTestId}`,
      (await page.getByTestId(homeTestId).count()) > 0,
    );
  }
  check(
    `${label}: header help link and account menu present`,
    (await page.getByTestId("link-help-header").count()) > 0 &&
      (await page.getByTestId("button-account-menu").count()) > 0,
  );
}

async function journeyPortalAuth(page, BASE, check) {
  const health = await page.request.get(BASE + "/api/healthz");
  const healthBody = await health.json();
  check(
    "health identifies the deployed build",
    health.ok() &&
      typeof healthBody.buildRevision === "string" &&
      healthBody.buildRevision.length > 0,
  );

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
  await checkPageAccessibility(page, check, "landing");
  check(
    "landing page links to the login portal",
    await page.getByTestId("link-hero-login").isVisible(),
  );

  const heroContact = page.getByTestId("link-hero-contact");
  check(
    "landing page offers a mailto contact path for prospects",
    (await heroContact.isVisible()) &&
      ((await heroContact.getAttribute("href")) ?? "").startsWith("mailto:"),
  );

  const calculatorLink = page.locator('a[href="/penalty-calculator/"]').first();
  check(
    "landing page links to the penalty calculator",
    await calculatorLink.isVisible(),
  );
  await calculatorLink.click();
  await page.waitForURL(BASE + "/penalty-calculator/");
  await checkPageAccessibility(page, check, "penalty calculator");
  check(
    "penalty calculator route serves its own application",
    (await page.getByTestId("text-page-title").innerText()).includes(
      "E-invoicing penalty estimator",
    ),
  );
  check(
    "calculator product CTA routes to the public product story, not the auth wall",
    (await page.getByTestId("link-product-cta").getAttribute("href")) ===
      "/#product-tour",
  );

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByTestId("link-hero-login").click();
  await page.waitForURL(BASE + "/login");
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
  await checkPageAccessibility(page, check, "login");
  check(
    "portal shows sign-in panel",
    await page.getByTestId("input-email").isVisible(),
  );

  await page.getByTestId("link-forgot-password").click();
  await page.waitForURL(BASE + "/reset-password");
  await page
    .getByTestId("input-reset-email")
    .fill("recovery-probe@nowhere.example");
  await page.getByTestId("button-request-reset").click();
  await page.waitForSelector('[data-testid="text-reset-request-sent"]');
  check(
    "forgot-password request returns the non-enumerating recovery state",
    (await page.getByTestId("text-reset-request-sent").innerText()).includes(
      "If an account exists",
    ),
  );

  await page.goto(BASE + "/login", { waitUntil: "networkidle" });

  await page.getByTestId("input-email").fill("ops@meridianiq.example");
  await page.getByTestId("input-password").fill("wrong-password");
  await page.getByTestId("button-sign-in").click();
  await page.waitForSelector('[data-testid="text-login-error"]');
  check(
    "bad password shows uniform error",
    (await page.getByTestId("text-login-error").innerText()).includes(
      "That email or password is not right",
    ),
  );

  // Login throttling (SEC-02): probe a throwaway identity via the API.
  let throttled = false;
  for (let i = 0; i < 6; i++) {
    const r = await page.request.post(BASE + "/api/auth/login", {
      data: { email: "probe@nowhere.example", password: "x".repeat(8) },
      headers: CSRF,
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
  await checkPageAccessibility(page, check, "operator queue");
  check(
    "operator lands on the work queue",
    (await page.getByTestId("text-page-title").innerText()).includes(
      "Operator work queue",
    ),
  );
  await page.waitForSelector("text=Client escalation", { timeout: 10000 });
  check("queue card carries client escalation context", true);
  check(
    "operator nav hides firm-only pages",
    (await page.getByTestId("nav-portfolio").count()) === 0,
  );

  // Error catalogue renders with entries
  await page.getByTestId("nav-error-catalogue").click();
  await page.waitForSelector('[data-testid="entry-MBS_INVALID_TIN"]', {
    timeout: 10000,
  });
  check("error catalogue lists entries", true);

  // Feature flag round trip
  await page.getByTestId("nav-feature-flags").click();
  await page.waitForSelector('[data-testid="switch-reconciliation"]');
  await page.getByTestId("switch-reconciliation").click();
  await page.waitForSelector("text=reconciliation enabled", { timeout: 8000 });
  await page.getByTestId("switch-reconciliation").click();
  // Disabling is platform-wide, so it is confirm-gated.
  await page.getByTestId("button-confirm-disable-flag").click();
  await page.waitForSelector("text=reconciliation disabled", { timeout: 8000 });
  check("feature flag toggles round-trip", true);

  // Platform ops: rails + retrying + messages sections render
  await page.getByTestId("nav-platform-ops").click();
  await page.waitForSelector('[data-testid="card-rails"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="card-retrying"]', {
    timeout: 10000,
  });
  await page.waitForSelector('[data-testid="card-messages"]', {
    timeout: 10000,
  });
  check("platform ops renders rails, retrying events and message log", true);

  // Control centre activation evidence + audit evidence
  await page.getByTestId("nav-control-centre").click();
  await page.waitForSelector('[data-testid="gate-time-to-stamp"]', {
    timeout: 10000,
  });
  check("control centre activation evidence renders", true);
  await page.getByTestId("nav-audit-&-evidence").click();
  await page.waitForSelector('[data-testid="card-chain-valid"]', {
    timeout: 10000,
  });
  check("audit chain verifies", true);

  // Party integrity workbench renders
  await page.getByTestId("nav-party-integrity").click();
  await page.waitForSelector('[data-testid="stat-parties"]', {
    timeout: 10000,
  });
  check("party workbench renders", true);

  await signOutFromApp(page, BASE);
}

// ---------- firm admin: advisory ----------
async function journeyFirmAdminAdvisory(page, BASE, check) {
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/");
  await page.waitForSelector('[data-testid="text-page-title"]');
  await checkPageAccessibility(page, check, "firm portfolio");
  check(
    "admin lands on portfolio",
    (await page.getByTestId("text-page-title").innerText()).includes(
      "Client portfolio",
    ),
  );
  // The console registers the same "?" cheat sheet as the SME app.
  await page.getByTestId("text-page-title").click();
  await page.keyboard.press("?");
  await page.waitForSelector('[data-testid="dialog-shortcuts"]', {
    timeout: 8000,
  });
  check("console ? opens the keyboard shortcut sheet", true);
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-advisory").click();
  await page.getByTestId("tab-vat-risk").click();
  await page
    .getByTestId("input-vat-csv")
    .fill(
      "invoice number,supplier tin,irn,csid,invoice amount,vat amount\nT-1,20000000-0002,IRN-X,CSID-X,100000,7500",
    );
  await page.getByTestId("button-analyze-vat").click();
  await page.waitForSelector('[data-testid="stat-vat-at-risk"]', {
    timeout: 15000,
  });
  check("VAT-risk analysis produces a report", true);
  await signOutFromApp(page, BASE);
}

// ---------- auditor: read-only boundary ----------
async function journeyAuditorReadOnly(page, BASE, check) {
  await signIn(page, BASE, "button-demo-audit", "**/console/audit");
  await page.waitForSelector('[data-testid="card-chain-valid"]', {
    timeout: 15000,
  });
  await checkShell(page, BASE, check, {
    label: "console auditor",
    roleText: "Read-only auditor",
  });
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
  // Session-expiry recovery: the guards bounce to /login?returnTo=<page>;
  // after sign-in the portal must land on that exact page, not the root.
  await page.goto(BASE + "/login?returnTo=/app/consent&reason=expired", {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('[data-testid="input-email"]', { timeout: 10000 });
  check(
    "expired-session sign-in shows the continue-where-you-left-off notice",
    await page.getByTestId("text-session-expired").isVisible(),
  );
  await page.getByTestId("input-email").fill("owner@adaezefoods.example");
  await page.getByTestId("input-password").fill(DEMO_PASSWORD);
  await page.getByTestId("button-sign-in").click();
  await page.waitForURL("**/app/consent", { timeout: 20000 });
  await page.waitForSelector('[data-testid="consent-layer-1"]', {
    timeout: 10000,
  });
  await checkPageAccessibility(page, check, "client consent");
  await checkShell(page, BASE, check, {
    label: "sme owner",
    roleText: "Business owner",
    workspaceText: "Adaeze Foods Ltd",
    homeTestId: "nav-today",
  });
  check(
    "consent page: layer 3 dormant",
    (
      await page.locator('[data-testid="consent-layer-3"]').innerText()
    ).includes("Not yet available"),
  );
  await page.waitForSelector(
    '[data-testid="button-grant-2"], [data-testid="button-revoke-2"]',
    { timeout: 10000 },
  );
  const startedGranted = (await page.getByTestId("button-revoke-2").count()) > 0;
  const grant = async () => {
    await page.getByTestId("button-grant-2").click();
    await page.waitForSelector('[data-testid="button-revoke-2"]', {
      timeout: 10000,
    });
  };
  const revoke = async () => {
    await page.getByTestId("button-revoke-2").click();
    // Revocation is confirm-gated: the dialog restates the consequence before
    // the ledger event is recorded.
    await page.getByTestId("button-confirm-revoke").click();
    await page.waitForSelector('[data-testid="button-grant-2"]', {
      timeout: 10000,
    });
  };
  if (startedGranted) {
    await revoke();
    await grant();
  } else {
    await grant();
    await revoke();
  }
  check("consent layer 2 grant/revoke round-trips", true);
  await signOutFromApp(page, BASE);
}

// ---------- SME owner, first landing: consent capture (D15) ----------
// Tunde Prints is seeded with NO consent event, so its owner's very first
// landing is the consent step, not the workspace. Both layers answered (allow
// 1, decline 2), the gate lifts, /me flips to captured, and the ledger shows
// the decline as a first-landing decision. On a reused database the decision
// already exists, so the journey checks the captured state only.
async function journeyFirstLandingConsent(page, BASE, check) {
  await signIn(page, BASE, "button-demo-tunde", "**/app/**");
  const before = await (await page.request.get(BASE + "/api/me")).json();
  if (before.consentCaptured === false) {
    await page.waitForSelector('[data-testid="consent-capture"]', {
      timeout: 15000,
    });
    check(
      "first landing shows the consent step instead of the workspace",
      (await page.getByTestId("nav-today").count()) === 0,
    );
    await checkPageAccessibility(page, check, "first-landing consent");
    check(
      "consent step: layer 3 is visible but offers no choice",
      (await page
        .getByTestId("consent-capture-layer-3")
        .locator("button")
        .count()) === 0,
    );
    const cont = page.getByTestId("button-consent-continue");
    check("consent step: Continue waits for both answers", await cont.isDisabled());
    await page.getByTestId("button-consent-allow-1").click();
    await page.getByTestId("button-consent-decline-2").click();
    check("consent step: Continue enables once both are answered", await cont.isEnabled());
    await cont.click();
    await page.waitForSelector('[data-testid="nav-today"]', { timeout: 15000 });
  }
  const after = await (await page.request.get(BASE + "/api/me")).json();
  check("consent captured: /me reports the decision", after.consentCaptured === true);
  const records = await (
    await page.request.get(BASE + `/api/parties/${after.clientPartyId}/consent`)
  ).json();
  const firstLanding = records.filter((r) => r.channel === "first_landing");
  check(
    "consent ledger holds one first_landing event per layer (grant 1, decline 2)",
    firstLanding.some((r) => r.layer === 1 && r.action === "grant") &&
      firstLanding.some((r) => r.layer === 2 && r.action === "revoke" && r.basis === "declined"),
  );
  await page.goto(BASE + "/app/consent", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="consent-layer-2"]', { timeout: 10000 });
  check(
    "consent page reads the first-landing decline as Declined, not Revoked",
    (await page.locator('[data-testid="consent-layer-2"]').innerText()).includes("Declined"),
  );
  // Reloading the workspace must not re-prompt: the decision is on the ledger.
  await page.goto(BASE + "/app", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="nav-today"]', { timeout: 15000 });
  check(
    "a decided business never sees the step again",
    (await page.getByTestId("consent-capture").count()) === 0,
  );
  // The vault as a shelf of the invoice list (D16): Today's stamped tile
  // deep-links to the Stamped view, and the filter rides the URL.
  await page.getByTestId("link-open-vault").click();
  await page.waitForSelector('[data-testid="filter-invoices-stamped"]', {
    timeout: 10000,
  });
  check(
    "Open vault lands on the Stamped shelf of the invoice list",
    page.url().includes("filter=stamped") &&
      (await page.getByTestId("filter-invoices-stamped").getAttribute("aria-pressed")) === "true",
  );
  await signOutFromApp(page, BASE);
}

// ---------- firm: per-staff client assignment (D12) ----------
// The admin assigns Kano Textiles to demo staff and Niger Delta Pharma to
// herself; staff then land on "My clients" (assigned + unassigned) with
// Pharma hidden, and "All clients" restores the whole book. Assignment
// never changes access: staff still opens Pharma's page by URL.
const KANO = "cb000002-0000-4000-8000-0000000000b2";
const PHARMA = "cb000003-0000-4000-8000-0000000000b3";
async function journeyClientAssignment(page, BASE, check) {
  await apiLogin(page, BASE, "demo.admin@meridianiq.example");
  const team = await (await page.request.get(BASE + "/api/console/team")).json();
  const staff = team.find((m) => m.email === "demo.staff@meridianiq.example");
  const admin = team.find((m) => m.email === "demo.admin@meridianiq.example");
  check("firm team lists the demo admin and staff", !!staff && !!admin);
  const assign = async (clientId, userIds) =>
    page.request.put(BASE + `/api/console/clients/${clientId}/assignments`, {
      data: { userIds },
      headers: CSRF,
    });
  const kano = await assign(KANO, [staff.userId]);
  const pharma = await assign(PHARMA, [admin.userId]);
  check(
    "firm admin assigns clients — status 200",
    kano.status() === 200 && pharma.status() === 200,
  );
  const outsider = await assign(KANO, [staff.userId, "00000000-0000-4000-8000-000000000000"]);
  check("an assignee outside the firm is refused — status 400", outsider.status() === 400);
  // Staff may read the register but not write it.
  await apiLogin(page, BASE, "demo.staff@meridianiq.example");
  const staffWrite = await assign(KANO, []);
  check("staff cannot rewrite assignments — status 403", staffWrite.status() === 403);
  await apiLogout(page, BASE);

  await signIn(page, BASE, "button-demo-demo.staff", "**/app/**");
  await page.goto(BASE + "/console", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="button-client-scope-mine"]', {
    timeout: 15000,
  });
  check(
    "assigned staff land on My clients by default",
    (await page.getByTestId("button-client-scope-mine").first().getAttribute("aria-pressed")) === "true",
  );
  await page.getByTestId("nav-portfolio").first().click();
  await page.goto(BASE + "/console?view=clients", { waitUntil: "networkidle" });
  await page.waitForSelector(`[data-testid="row-client-${KANO}"]`, { timeout: 15000 });
  check(
    "My clients hides a client assigned only to someone else",
    (await page.locator(`[data-testid="row-client-${PHARMA}"]`).count()) === 0,
  );
  await checkPageAccessibility(page, check, "portfolio, My clients");
  await page.getByTestId("button-client-scope-all").last().click();
  await page.waitForSelector(`[data-testid="row-client-${PHARMA}"]`, { timeout: 10000 });
  check("All clients restores the whole book", true);
  // Access is unchanged: the hidden client still opens by URL, and shows its team.
  await page.goto(BASE + `/console/clients/${PHARMA}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="card-client-team"]', { timeout: 15000 });
  check(
    "assignment never narrows access: staff opens an unassigned-to-them client",
    (await page.getByTestId("text-client-name").innerText()).includes("Niger Delta Pharma") &&
      (await page.locator(`[data-testid="text-assignee-${admin.userId}"]`).count()) === 1,
  );
  await signOutFromApp(page, BASE);

  // The admin's route to "get my client a login" starts on the client page:
  // the Team card links straight into the invitation form with the client
  // role and this party preselected (cognitive walkthrough W-1).
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/**");
  await page.goto(BASE + `/console/clients/${PHARMA}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="link-invite-client-login"]', { timeout: 15000 });
  const inviteHref = await page.getByTestId("link-invite-client-login").getAttribute("href");
  check(
    "client page offers an invite-a-client-login link scoped to that client",
    (inviteHref ?? "").endsWith(`/invitations?role=client_user&clientPartyId=${PHARMA}`),
  );
  await page.getByTestId("link-invite-client-login").click();
  await page.waitForSelector('[data-testid="select-client"]', { timeout: 15000 });
  check(
    "invitation form opens on the client role with that client preselected",
    (await page.getByTestId("select-client").innerText()).includes("Niger Delta Pharma"),
  );
  await signOutFromApp(page, BASE);
}

// ---------- firm admin: lightweight access review (D14) ----------
// Runs after the assignment journey so the register shows Kano Textiles
// against demo staff. The admin sees every member with role, since-when,
// last sign-in and MFA state, attests the register (an audit-chain event),
// and a stale hash is refused.
async function journeyAccessReview(page, BASE, check) {
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/**");
  await page.getByTestId("nav-access-review").first().click();
  await page.waitForSelector('[data-testid="card-access-register"]', {
    timeout: 15000,
  });
  await checkPageAccessibility(page, check, "access review");
  const register = await (
    await page.request.get(BASE + "/api/console/access-register")
  ).json();
  const staff = register.members.find(
    (m) => m.email === "demo.staff@meridianiq.example",
  );
  const admin = register.members.find(
    (m) => m.email === "demo.admin@meridianiq.example",
  );
  check(
    "access register lists the firm's members with roles",
    !!staff && staff.role === "firm_staff" && !!admin && admin.role === "firm_admin",
  );
  check(
    "access register shows the admin's sign-in and the staff assignment",
    !!admin.lastSignInAt &&
      (await page.getByTestId(`text-member-clients-${staff.userId}`).innerText()).includes(
        "Kano Textiles",
      ),
  );
  const stale = await page.request.post(
    BASE + "/api/console/access-register/attest",
    { data: { hash: "not-the-register" }, headers: CSRF },
  );
  check("attesting a stale register hash is refused — status 409", stale.status() === 409);
  const attestButton = page.getByTestId("button-attest-access");
  check("attest button is armed before the first review", await attestButton.isEnabled());
  await attestButton.click();
  await page.waitForSelector("text=Attested — nothing changed", { timeout: 10000 });
  const after = await (
    await page.request.get(BASE + "/api/console/access-register")
  ).json();
  check(
    "attestation is recorded against the current hash by the admin",
    after.lastAttestation?.hash === after.hash &&
      after.lastAttestation?.byUserId === admin.userId,
  );
  const csv = await page.request.get(BASE + "/api/console/access-register/csv");
  check(
    "access register downloads as CSV",
    csv.status() === 200 && (await csv.text()).includes("demo.staff@meridianiq.example"),
  );
  await signOutFromApp(page, BASE);
}

// ---------- firm admin: onboarding pipeline ----------
// A won prospect is not a dead end: cards carry the contact email captured
// at creation, and moving one to Active opens the client-book dialog
// prefilled with its name (the Active card keeps an "Add to client book"
// button for later).
async function journeyPipeline(page, BASE, check) {
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/**");
  await page.goto(BASE + "/console/pipeline", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid^="card-prospect-"]', { timeout: 15000 });
  const card = page
    .locator('[data-testid^="card-prospect-"]', { hasText: "Port Harcourt Oil Services" })
    .first();
  const id = (await card.getAttribute("data-testid")).replace("card-prospect-", "");
  check(
    "pipeline cards show the prospect's contact email",
    (await page.getByTestId(`text-prospect-email-${id}`).innerText()).includes(
      "ops@phoilservices.example",
    ),
  );
  await page.getByTestId(`select-stage-${id}`).click();
  await page.getByRole("option", { name: "Active" }).click();
  await page.waitForSelector('[data-testid="input-add-client-name"]', { timeout: 15000 });
  check(
    "moving a prospect to Active opens the client-book dialog prefilled with its name",
    (await page.getByTestId("input-add-client-name").inputValue()) ===
      "Port Harcourt Oil Services",
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="input-add-client-name"]', {
    state: "detached",
    timeout: 10000,
  });
  await page.waitForSelector(`[data-testid="button-add-to-clients-${id}"]`, { timeout: 15000 });
  check("an Active prospect card offers Add to client book", true);
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
  // The signed-in portal's footer offers "Switch account", which lands on the
  // sign-out button instead of the old no-op "Sign in".
  await page.getByTestId("button-footer-switch-account").click();
  check(
    "signed-in portal footer switches account by focusing sign-out",
    (await page.evaluate(() => globalThis.document?.activeElement?.id)) === "sign-out",
  );

  // Enable: secret, otpauth URI and the 8 recovery codes are shown once.
  await page.getByTestId("button-totp-enable").click();
  await page.waitForSelector('[data-testid="text-totp-secret"]', {
    timeout: 10000,
  });
  const secret = (
    await page.getByTestId("text-totp-secret").innerText()
  ).trim();
  check("enrolment reveals a base32 secret", /^[A-Z2-7]{16,}$/.test(secret));
  check(
    "eight single-use recovery codes are shown",
    (await page.locator('[data-testid="list-recovery-codes"] li').count()) ===
      8,
  );

  // Activate with a live code computed in the harness from that secret.
  const activateButton = page.getByTestId("button-totp-activate");
  check(
    "activation waits until the recovery codes are acknowledged",
    await activateButton.isDisabled(),
  );
  await page.getByTestId("checkbox-recovery-saved").check();
  await page.getByTestId("input-totp-activate").fill(await freshCode(secret));
  check(
    "acknowledging the recovery codes enables activation",
    await activateButton.isEnabled(),
  );
  await activateButton.click();
  await page.waitForSelector('[data-testid="text-totp-enabled"]', {
    timeout: 10000,
  });
  check(
    "live code activates two-factor; the panel survives the re-issued cookie",
    (await page.getByTestId("text-recovery-remaining").innerText()).includes(
      "8",
    ),
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
  check(
    "challenge step says it expires and how much time is left",
    (await page.locator("#totp-help").innerText()).includes("five minutes") &&
      /about (\d+ minutes|a minute) left/.test(
        await page.getByTestId("text-totp-expiry").innerText(),
      ),
  );

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
  await page
    .getByTestId("input-totp-disable-code")
    .fill(await freshCode(secret));
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

export {
  journeyFirstLandingConsent,
  journeyClientAssignment,
  journeyAccessReview,
  journeyPipeline,
  journeyPortalAuth,
  journeyOperatorDesk,
  journeyFirmAdminAdvisory,
  journeyAuditorReadOnly,
  journeyOwnerConsent,
  journeyTotp,
};
