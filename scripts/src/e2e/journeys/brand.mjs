import { CSRF, DEMO_PASSWORD, apiLogout } from "./shared.mjs";

// ---------- brand compatibility (R112) ----------
// The rebrand kept the wire compatible: the request headers accept both the
// Valo and the historical MeridianIQ spellings, a conflicting pair fails
// closed, and /api/metrics exposes every valo_* series with a meridian_* twin
// (docs/valo-rebrand.md § Compatibility behavior). The HTTP-level suite
// (api-server valo-rebrand.integration.test.ts) proves this against the
// Express app; this journey proves it against the BUILT server behind the
// path-router the deployment uses. Since R112 the harness itself sends the
// Valo spelling on every fixture call (scripts/src/test-client.mjs), so the
// legacy alias is exercised here on purpose. Read-only apart from its own
// sign-ins; it ends signed out.
const OPS = "ops@valo.example";

function login(page, BASE, headers) {
  return page.request.post(BASE + "/api/auth/login", {
    data: { email: OPS, password: DEMO_PASSWORD },
    headers,
  });
}

function issuedSession(response) {
  return response
    .headersArray()
    .some((header) => header.name.toLowerCase() === "set-cookie");
}

async function journeyBrandCompatibility(page, BASE, check) {
  await apiLogout(page, BASE);

  for (const [label, csrf] of [
    ["legacy x-meridian-csrf", { "x-meridian-csrf": "1" }],
    ["x-valo-csrf", { "x-valo-csrf": "1" }],
  ]) {
    const signedIn = await login(page, BASE, csrf);
    const body = signedIn.status() === 200 ? await signedIn.json() : null;
    const signedOut = await page.request.post(BASE + "/api/auth/logout", {
      headers: csrf,
    });
    check(
      `${label} signs a browser in cookie-only and out again through the built stack`,
      signedIn.status() === 200 &&
        Boolean(body) &&
        !("token" in body) &&
        issuedSession(signedIn) &&
        signedOut.status() === 204,
      `login ${signedIn.status()}, logout ${signedOut.status()}`,
    );
  }

  const bare = await login(page, BASE, {});
  check(
    "a state change without either CSRF spelling is refused (403) and no session is issued",
    bare.status() === 403 && !issuedSession(bare),
    `status ${bare.status()}`,
  );

  const conflict = await login(page, BASE, {
    "x-valo-csrf": "1",
    "x-meridian-csrf": "conflict",
  });
  check(
    "conflicting CSRF aliases are refused (400) and no session is issued",
    conflict.status() === 400 && !issuedSession(conflict),
    `status ${conflict.status()}`,
  );

  for (const [label, client] of [
    ["x-valo-client", { ...CSRF, "x-valo-client": "mobile" }],
    ["legacy x-meridian-client", { ...CSRF, "x-meridian-client": "mobile" }],
  ]) {
    const mobile = await login(page, BASE, client);
    const body = mobile.status() === 200 ? await mobile.json() : null;
    const me = body?.token
      ? await page.request.get(BASE + "/api/me", {
          headers: { authorization: `Bearer ${body.token}` },
        })
      : null;
    check(
      `${label}: mobile returns a bearer the API accepts alongside the cookie`,
      Boolean(body?.token) && me?.status() === 200,
      `login ${mobile.status()}, me ${me?.status() ?? "-"}`,
    );
    await apiLogout(page, BASE);
  }

  // Metrics: the server emits the valo_* text and appends a meridian_* copy
  // of every HELP, TYPE and sample line — one measurement, two names. The
  // harness runs the API in development, where the scrape is open.
  const metrics = await page.request.get(BASE + "/api/metrics");
  const text = metrics.ok() ? await metrics.text() : "";
  const lines = text.split("\n");
  const samples = lines.filter((line) => /^valo_/.test(line));
  const twins = new Set(lines.filter((line) => /^meridian_/.test(line)));
  const unpaired = samples.filter(
    (line) => !twins.has(line.replace(/^valo_/, "meridian_")),
  );
  check(
    "/api/metrics exposes every valo_ sample with a meridian_ twin of equal value",
    metrics.status() === 200 && samples.length > 0 && unpaired.length === 0,
    `status ${metrics.status()}, ${samples.length} valo_ samples, ${unpaired.length} unpaired`,
  );
  const meta = lines.filter((line) => /^# (?:HELP|TYPE) valo_/.test(line));
  const metaTwins = new Set(
    lines.filter((line) => /^# (?:HELP|TYPE) meridian_/.test(line)),
  );
  const unpairedMeta = meta.filter(
    (line) =>
      !metaTwins.has(line.replace(/^(# (?:HELP|TYPE) )valo_/, "$1meridian_")),
  );
  check(
    "/api/metrics aliases the HELP and TYPE lines and declares the sweep counter under both names",
    meta.length > 0 &&
      unpairedMeta.length === 0 &&
      /^# TYPE valo_sweep_runs_total counter$/m.test(text) &&
      /^# TYPE meridian_sweep_runs_total counter$/m.test(text),
    `${meta.length} metadata lines, ${unpairedMeta.length} unpaired`,
  );
}

export { journeyBrandCompatibility };
