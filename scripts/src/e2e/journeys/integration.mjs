// The integration-layer journey: API keys, webhook endpoints (HMAC
// signatures verified end to end), the access-point rail's rejected path
// (R95: the whole run stamps over HTTP through the conformance fake rail)
// and payment intents.
import { createHash, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import {
  createSweepTrigger,
  invoiceProbeDiagnostic,
} from "./sweep-trigger.mjs";
import {
  CSRF,
  DEMO_CLIENT_PARTY_PREFIX,
  apiLogin,
  apiLogout,
  createDraftInvoice,
  pollUntil,
  signIn,
  signOutFromApp,
} from "./shared.mjs";

// ---------- firm admin: integration layer (API keys, webhooks, payments) -----
// The machine-facing seams end-to-end against the real stack: mint a firm API
// key and prove bearer auth + instant revocation with cookie-free fetches,
// register a webhook pointing at the harness's local receiver, drive a fresh
// invoice through validate → submit → stamp and verify the signed
// pointer-only delivery, prove the stamp came over the HTTP transport and
// drive a SECOND probe into the rail's rejected path (the fake rail is
// scripted to refuse it, so the platform must fail the invoice with the
// catalogue code and open a Desk case), then collect the demo firm's
// platform bill through the payment-intent + confirmation-webhook rail
// (run.mjs sets PAYMENT_WEBHOOK_TOKEN on the api-server env — read per call
// server-side — and threads the same value in here as paymentWebhookToken).
// fakeRailUrl / fakeRailToken are the conformance rail run.mjs booted and
// pointed RAIL_PRIMARY_URL / RAIL_PRIMARY_TOKEN at; its /__fake control
// endpoints need no credentials (loopback tooling), so the token is only
// what the rail's calls log must report the api-server as having presented.
//
// Runs AFTER the staff/password journeys: it must not add invoices before the
// credit-note journey picks its target, and the password journeys need
// demo.staff's session/password chain undisturbed. Rerun-clean: the key is
// revoked, the webhook disabled (so a kept database never keeps POSTing at a
// dead port), both probe invoice numbers are fresh per run, and the payment
// leg accepts the 409 an already-collected month answers on reruns. The
// rejected probe and its Desk case stay behind on purpose — like the
// payables journey's flags they are append-only evidence, and no journey
// reads the queue by position.
//
// Bearer probes ride the harness's PLAIN fetch, not page.request: Node keeps
// no cookie jar, so the request provably carries ONLY the Authorization
// header. (page.request would also attach the signed-in admin cookie; the
// server short-circuits mk_ tokens before any cookie path — principal.ts —
// so it would still pass, but the cookie-free probe proves the revoked-key
// 401 with no ambient-credential caveat.)
async function journeyIntegrationLayer(
  page,
  BASE,
  check,
  hookReceiver,
  paymentWebhookToken,
  sweepToken,
  fakeRailUrl,
  fakeRailToken,
) {
  const triggerSweep = createSweepTrigger(page.request, BASE, sweepToken);
  async function submitProbe(created) {
    assert.equal(created.status, 201, "integration probe must be created");
    assert.ok(created.invoiceId, "integration probe must have an invoice id");
    const validated = await page.request.post(
      BASE + `/api/invoices/${created.invoiceId}/validate`,
      { headers: CSRF },
    );
    assert.equal(validated.status(), 200, "integration probe must validate");
    const submitted = await page.request.post(
      BASE + `/api/invoices/${created.invoiceId}/submit`,
      { headers: CSRF },
    );
    assert.equal(
      submitted.status(),
      202,
      "integration probe must be accepted for submission",
    );
  }
  // The reset journey leaves an ops session in the browser context (API
  // login); drop it so the portal shows the demo buttons again.
  await apiLogout(page, BASE);
  await signIn(page, BASE, "button-demo-demo.admin", "**/console/");

  // -- API key: minted once, bearer-authenticates, dies on revoke ------------
  const minted = await page.request.post(BASE + "/api/firm-api-keys", {
    data: { name: "e2e key", capabilities: ["invoice.read"] },
    headers: CSRF,
  });
  const key = minted.status() === 201 ? await minted.json() : null;
  check(
    "firm API key mints with a shown-once mk_ secret",
    minted.status() === 201 &&
      /^mk_[0-9a-f]{6}_[A-Za-z0-9_-]{32}$/.test(key?.secret ?? "") &&
      (key?.capabilities ?? []).includes("invoice.read"),
    `status ${minted.status()}`,
  );

  const bearerGet = () =>
    fetch(BASE + "/api/invoices", {
      headers: { authorization: `Bearer ${key?.secret ?? "mk_missing"}` },
    });
  const asKey = await bearerGet();
  const keyRows = asKey.status === 200 ? await asKey.json() : null;
  check(
    "bearer mk_ key authenticates a cookie-free invoice read",
    asKey.status === 200 && Array.isArray(keyRows) && keyRows.length > 0,
    `status ${asKey.status}`,
  );

  const revoked = await page.request.post(
    BASE + `/api/firm-api-keys/${key?.id}/revoke`,
    { headers: CSRF },
  );
  const afterRevoke = await bearerGet();
  check(
    "revoked mk_ key stops authenticating immediately (401)",
    revoked.status() === 200 && afterRevoke.status === 401,
    `revoke ${revoked.status()}, then ${afterRevoke.status}`,
  );

  // -- Webhook: register, drive a stamping, verify the signed delivery ------
  // NODE_ENV=development allows the loopback URL (production vetting demands
  // https + a public host).
  const hooked = await page.request.post(BASE + "/api/firm-webhooks", {
    data: {
      url: `http://127.0.0.1:${hookReceiver?.port}/hook`,
      events: ["invoice.stamped"],
    },
    headers: CSRF,
  });
  const hook = hooked.status() === 201 ? await hooked.json() : null;
  check(
    "firm webhook registers with a shown-once whsec_ secret",
    hooked.status() === 201 &&
      /^whsec_[A-Za-z0-9_-]{32}$/.test(hook?.secret ?? ""),
    `status ${hooked.status()}`,
  );

  // Fan-out only picks up events NEWER than the webhook, so the stamping is
  // driven after registration: a fresh draft on the seeded, consented demo
  // client's party pair (proven stampable by the credit-note journey), then
  // validate → submit → the pipeline stamps it. GET /api/internal/sweep runs
  // one full worker pass synchronously, so the poll forces drain + webhook
  // fan-out/dispatch instead of waiting out timers. The trigger is fail-closed
  // behind SWEEP_TOKEN (run.mjs sets it on the api-server env and threads the
  // same value in here), presented as x-op-token like the other machine rails.
  // The pattern MUST be a demo-CLIENT invoice (supplier = the seeded client
  // party): since the payables round the book also carries BILLS — captured
  // vendor invoices whose supplier is NOT an engaged client — and copying a
  // bill's supplier would build a probe the orientation guard refuses to
  // submit (409 NOT_SUBMITTABLE). No un-scoped fallback: a seed without a
  // demo-client invoice is broken, so fail loudly here instead of limping
  // into misleading downstream failures.
  // Bounded reads (R98): one newest-first page of at most 200 rows (the
  // seeded book plus every journey's additions is far smaller), sorted
  // oldest-first here so the pattern stays the boot-seeded INV-1001.
  const book = await (
    await page.request.get(BASE + "/api/invoices?limit=200")
  ).json();
  const pattern = book
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .find(
      (i) =>
        i.kind === "invoice" &&
        i.supplierPartyId?.startsWith(DEMO_CLIENT_PARTY_PREFIX),
    );
  if (!pattern) {
    throw new Error(
      "integration journey: no demo-client invoice (supplier 22222222…) in " +
        "the seeded book to pattern the webhook probe on",
    );
  }
  const created = await createDraftInvoice(page, BASE, {
    supplierPartyId: pattern.supplierPartyId,
    buyerPartyId: pattern.buyerPartyId,
    invoiceNumber: `E2E-INT-${Date.now()}`,
    issueDate: new Date().toISOString().slice(0, 10),
    description: "E2E integration probe",
    unitPrice: "25000",
  });
  const invoiceId = created.invoiceId;
  const findDelivery = () =>
    (hookReceiver?.deliveries ?? []).find((d) => {
      try {
        return JSON.parse(d.body).entityId === invoiceId;
      } catch {
        return false;
      }
    });
  let deliveredInTime;
  let disabledRes;
  try {
    await submitProbe(created);
    deliveredInTime = await pollUntil(
      async () => {
        await triggerSweep();
        return Boolean(findDelivery());
      },
      { tries: 90, delayMs: 1000, page },
    );
  } finally {
    disabledRes = await page.request.post(
      BASE + `/api/firm-webhooks/${hook?.id}/disable`,
      {
        headers: CSRF,
      },
    );
  }
  const diagnostic = deliveredInTime
    ? ""
    : await invoiceProbeDiagnostic(page.request, BASE, invoiceId);
  const delivery = findDelivery();
  check(
    "stamping fans out a webhook delivery to the local receiver",
    Boolean(deliveredInTime && invoiceId && delivery) &&
      delivery?.event === "invoice.stamped" &&
      delivery?.path === "/hook",
    `deliveries recorded: ${hookReceiver?.deliveries?.length ?? 0}${diagnostic ? `; ${diagnostic}` : ""}`,
  );

  // Signature: HMAC-SHA256 over the raw body, keyed by sha256hex(secret) —
  // recomputed here from the shown-once secret. Pointer-only (SEC-12): the
  // body carries entity type + id, never amounts, names or document content.
  const hmacKey = createHash("sha256")
    .update(hook?.secret ?? "")
    .digest("hex");
  const expectedSig = delivery
    ? createHmac("sha256", hmacKey).update(delivery.body).digest("hex")
    : null;
  let payload = null;
  try {
    payload = delivery ? JSON.parse(delivery.body) : null;
  } catch {
    payload = null;
  }
  const leakFields = [
    "amountNgn",
    "total",
    "lines",
    "legalName",
    "tin",
    "invoiceNumber",
  ];
  check(
    "delivery is HMAC-signed (sha256hex of the whsec_ secret) and pointer-only",
    Boolean(delivery) &&
      delivery?.signature === expectedSig &&
      payload?.entityType === "invoice" &&
      payload?.entityId === invoiceId &&
      leakFields.every((f) => !(f in (payload ?? {}))),
  );

  // Delivery history shows the delivered attempt; disable stops the endpoint
  // (rerun hygiene: the receiver dies with this process).
  const historyRes = await page.request.get(
    BASE + `/api/firm-webhooks/${hook?.id}/deliveries`,
  );
  const history = historyRes.status() === 200 ? await historyRes.json() : [];
  const disabled =
    disabledRes.status() === 200 ? await disabledRes.json() : null;
  check(
    "delivery history records the delivered attempt; disable round-trips",
    history.some((d) => d.status === "delivered") && disabled?.active === false,
    `history rows: ${history.length}`,
  );

  // -- Rail transport (R95): provenance, then the rejected path -------------
  // The webhook probe above was stamped by the api-server's HTTP transport
  // talking to the conformance fake rail run.mjs booted (RAIL_PRIMARY_URL),
  // so its stamp record must carry THAT provenance — provider "http" and the
  // RAIL_ENVIRONMENT the harness set — rather than the simulator's. A stamp
  // that still read "simulator" would mean boot-time transport selection
  // silently fell back, which no unit test can catch.
  const stampRes = await page.request.get(
    BASE + `/api/invoices/${invoiceId}/stamp`,
  );
  const stamp = stampRes.status() === 200 ? await stampRes.json() : null;
  check(
    "the stamped probe carries the HTTP transport's provenance",
    stamp?.provider === "http" &&
      stamp?.environment === "sandbox" &&
      stamp?.rail === "rail_primary",
    `status ${stampRes.status()}: ${stamp?.provider ?? "?"}/${stamp?.environment ?? "?"} via ${stamp?.rail ?? "?"}`,
  );

  // Rejected path: script the fake rail to refuse the NEXT submission of
  // this invoice number with a terminal catalogue code BEFORE the platform
  // ever sees the invoice (the script is keyed by invoice number, so it
  // cannot leak onto any other probe), then drive the same
  // create → validate → submit path and let the sweep drain it. A rejection
  // is a "dead" pipeline disposition: the invoice goes `failed`, the attempt
  // row records the code, and the dead-lettered submit opens a Desk case.
  const rejectedNumber = `E2E-REJ-${Date.now()}`;
  const scripted = await fetch(`${fakeRailUrl}/__fake/script`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invoiceNumber: rejectedNumber,
      outcome: "reject",
      code: "MBS_INVALID_TIN",
    }),
  });
  if (scripted.status !== 204) {
    throw new Error(
      `integration journey: fake rail refused the rejection script (${scripted.status})`,
    );
  }
  const rejected = await createDraftInvoice(page, BASE, {
    supplierPartyId: pattern.supplierPartyId,
    buyerPartyId: pattern.buyerPartyId,
    invoiceNumber: rejectedNumber,
    issueDate: new Date().toISOString().slice(0, 10),
    description: "E2E rejection probe",
    unitPrice: "12000",
  });
  const rejectedId = rejected.invoiceId;
  await submitProbe(rejected);
  const readRejected = async () => {
    const r = await page.request.get(BASE + `/api/invoices/${rejectedId}`);
    return r.status() === 200 ? await r.json() : null;
  };
  const failedInTime =
    Boolean(rejectedId) &&
    (await pollUntil(
      async () => {
        await triggerSweep();
        return (await readRejected())?.invoice?.status === "failed";
      },
      { tries: 90, delayMs: 1000, page },
    ));
  const attemptsRes = await page.request.get(
    BASE + `/api/invoices/${rejectedId}/attempts`,
  );
  const attempts = attemptsRes.status() === 200 ? await attemptsRes.json() : [];
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const lightRes = await page.request.get(
    BASE + `/api/invoices/${rejectedId}/status-light`,
  );
  const light = lightRes.status() === 200 ? await lightRes.json() : null;
  check(
    "a rail rejection fails the invoice with its catalogue code",
    failedInTime &&
      lastAttempt?.status === "rejected" &&
      lastAttempt?.errorCode === "MBS_INVALID_TIN" &&
      lastAttempt?.rail === "rail_primary" &&
      light?.light === "red" &&
      String(light?.reasons?.[0] ?? "").includes("MBS_INVALID_TIN"),
    rejectedId
      ? `failed in time: ${failedInTime}; attempts: ${attempts.length}; last ${lastAttempt?.status ?? "?"}/${lastAttempt?.errorCode ?? "?"}; light ${light?.light ?? "?"}`
      : `rejection probe not created (${rejected.status})`,
  );

  // The rail's own view: exactly one submission for the number (a terminal
  // rejection is never retried), presented with the bearer run.mjs set as
  // RAIL_PRIMARY_TOKEN and with the idempotency key on the wire header
  // matching the body — the two halves of the protocol a real access point
  // dedupes on.
  const callsRes = await fetch(`${fakeRailUrl}/__fake/calls`);
  const calls = callsRes.status === 200 ? await callsRes.json() : [];
  const railCalls = calls.filter((c) => c.invoiceNumber === rejectedNumber);
  const railCall = railCalls[0] ?? null;
  check(
    "the fake rail saw exactly one authorized submission for it",
    railCalls.length === 1 &&
      railCall?.outcome === "reject" &&
      railCall?.authorized === true &&
      Boolean(railCall?.idempotencyKey) &&
      railCall?.idempotencyHeader === railCall?.idempotencyKey,
    `calls for ${rejectedNumber}: ${railCalls.length} (fake rail token ${fakeRailToken ? "set" : "unset"})`,
  );

  // Operator view: the dead-lettered submit opened one high-priority Desk
  // case carrying the code, and platform ops names the live transport and
  // which rail it serves. Operator endpoints need an ops session; the API
  // login swaps the browser context's cookie, and the admin session is
  // restored the same way before the payment leg below.
  await apiLogin(page, BASE, "ops@valo.example");
  const casesRes = await page.request.get(
    BASE + "/api/operator/cases?status=open",
  );
  const openCases = casesRes.status() === 200 ? await casesRes.json() : [];
  const probeCases = openCases.filter((c) => c.invoiceId === rejectedId);
  check(
    "the rejection opens one high-priority Desk case",
    Boolean(rejectedId) &&
      probeCases.length === 1 &&
      probeCases[0]?.errorCode === "MBS_INVALID_TIN" &&
      probeCases[0]?.priority === "high",
    `open cases for the probe: ${probeCases.length} of ${openCases.length}`,
  );

  const railsRes = await page.request.get(BASE + "/api/operator/rails");
  const rails = railsRes.status() === 200 ? await railsRes.json() : [];
  const primary = rails.find((r) => r.rail === "rail_primary") ?? null;
  // /operator/rails ALWAYS lists both rails: rail_secondary is only gated
  // (and so only gets a breaker row) after a failover attempt, so with one
  // lit rail the route synthesises its row — closed, never tripped, and
  // reading unconfigured because the transport does not serve it.
  const secondary = rails.find((r) => r.rail === "rail_secondary") ?? null;
  const configRes = await page.request.get(BASE + "/api/operator/rail-config");
  const railConfig = configRes.status() === 200 ? await configRes.json() : [];
  const configured = (key) =>
    railConfig.find((e) => e.key === key)?.configured ?? null;
  check(
    "platform ops reports the HTTP transport and which rail is lit",
    primary?.transport === "http" &&
      primary?.environment === "sandbox" &&
      primary?.configured === true &&
      secondary?.transport === "http" &&
      secondary?.configured === false &&
      secondary?.state === "closed" &&
      configured("rail_primary") === true &&
      configured("rail_secondary") === false,
    `rails: ${rails.map((r) => `${r.rail}=${r.transport}/${r.environment}/${r.configured}/${r.state}`).join(", ") || "none"}; config primary ${configured("rail_primary")}, secondary ${configured("rail_secondary")}`,
  );
  await apiLogin(page, BASE, "demo.admin@valo.example");

  // -- Payments: intent for a closed month, settled by the machine rail -----
  // The statement's default month is the newest closed Lagos month; if its
  // computed fee were zero, probe the option list for a month that bills
  // (the seeded demo firm's Compliance Desk tier bills a base fee every
  // month, so the probe is a defensive no-op on the standard seed).
  const stmtRes = await page.request.get(BASE + "/api/billing/statement");
  const stmt = stmtRes.status() === 200 ? await stmtRes.json() : null;
  let payMonth = stmt?.monthStart ?? null;
  if (stmt && !(Number(stmt.fee?.total) > 0)) {
    for (const m of stmt.months ?? []) {
      const probe = await page.request.get(
        BASE + `/api/billing/statement?month=${m.value}`,
      );
      if (
        probe.status() === 200 &&
        Number((await probe.json()).fee?.total) > 0
      ) {
        payMonth = m.value;
        break;
      }
    }
  }
  const intentRes = await page.request.post(BASE + "/api/billing/payments", {
    data: { monthStart: payMonth },
    headers: CSRF,
  });
  const intentStatus = intentRes.status();
  const intentBody = await intentRes.json().catch(() => null);
  // 201 = fresh intent; 409 = a live intent already holds the month (rerun on
  // a kept database); 400 "Nothing to collect" = a seed that bills nothing.
  const zeroFee =
    intentStatus === 400 &&
    String(intentBody?.error ?? "").includes("Nothing to collect");
  check(
    "payment intent for the newest closed billing month answers in contract",
    intentStatus === 201 || intentStatus === 409 || zeroFee,
    `status ${intentStatus} for ${payMonth}`,
  );
  if (intentStatus === 201) {
    // The confirmation webhook is a machine rail: cookie-free plain fetch,
    // the shared token as x-op-token, 202 either way by design — then the
    // firm-visible list proves the CAS actually settled the intent.
    const confirmRes = await fetch(BASE + "/api/billing/payments/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-op-token": paymentWebhookToken,
      },
      body: JSON.stringify({
        providerRef: intentBody.providerRef,
        outcome: "confirmed",
      }),
    });
    const settled =
      confirmRes.status === 202 &&
      (await pollUntil(
        async () => {
          const list = await page.request.get(BASE + "/api/billing/payments");
          if (list.status() !== 200) return false;
          return (await list.json()).some(
            (p) => p.id === intentBody.id && p.status === "confirmed",
          );
        },
        { tries: 6, delayMs: 500, page },
      ));
    check(
      "payment confirm rail (x-op-token) settles the intent to confirmed",
      settled,
      `confirm status ${confirmRes.status}`,
    );
  }

  await signOutFromApp(page, BASE);
}

export { journeyIntegrationLayer };
