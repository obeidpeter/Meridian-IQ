// The integration-layer journey: API keys, webhook endpoints (HMAC
// signatures verified end to end) and payment intents.
import { createHash, createHmac } from "node:crypto";
import {
  CSRF,
  DEMO_CLIENT_PARTY_PREFIX,
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
// pointer-only delivery, then collect the demo firm's platform bill through
// the payment-intent + confirmation-webhook rail (run.mjs sets
// PAYMENT_WEBHOOK_TOKEN on the api-server env — read per call server-side —
// and threads the same value in here as paymentWebhookToken).
//
// Runs AFTER the staff/password journeys: it must not add invoices before the
// credit-note journey picks its target, and the password journeys need
// demo.staff's session/password chain undisturbed. Rerun-clean: the key is
// revoked, the webhook disabled (so a kept database never keeps POSTing at a
// dead port), the probe invoice number is fresh per run, and the payment leg
// accepts the 409 an already-collected month answers on reruns.
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
) {
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
    hooked.status() === 201 && /^whsec_[A-Za-z0-9_-]{32}$/.test(hook?.secret ?? ""),
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
  const book = await (await page.request.get(BASE + "/api/invoices")).json();
  const pattern = book.find(
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
  if (invoiceId) {
    await page.request.post(BASE + `/api/invoices/${invoiceId}/validate`, {
      headers: CSRF,
    });
    await page.request.post(BASE + `/api/invoices/${invoiceId}/submit`, {
      headers: CSRF,
    });
  }
  const findDelivery = () =>
    (hookReceiver?.deliveries ?? []).find((d) => {
      try {
        return JSON.parse(d.body).entityId === invoiceId;
      } catch {
        return false;
      }
    });
  await pollUntil(
    async () => {
      await page.request.get(BASE + "/api/internal/sweep", {
        headers: { "x-op-token": sweepToken },
      });
      return Boolean(findDelivery());
    },
    { tries: 15, delayMs: 1000, page },
  );
  const delivery = findDelivery();
  check(
    "stamping fans out a webhook delivery to the local receiver",
    Boolean(invoiceId && delivery) &&
      delivery?.event === "invoice.stamped" &&
      delivery?.path === "/hook",
    invoiceId ? `deliveries recorded: ${hookReceiver?.deliveries?.length ?? 0}` : "probe invoice not created",
  );

  // Signature: HMAC-SHA256 over the raw body, keyed by sha256hex(secret) —
  // recomputed here from the shown-once secret. Pointer-only (SEC-12): the
  // body carries entity type + id, never amounts, names or document content.
  const hmacKey = createHash("sha256").update(hook?.secret ?? "").digest("hex");
  const expectedSig = delivery
    ? createHmac("sha256", hmacKey).update(delivery.body).digest("hex")
    : null;
  let payload = null;
  try {
    payload = delivery ? JSON.parse(delivery.body) : null;
  } catch {
    payload = null;
  }
  const leakFields = ["amountNgn", "total", "lines", "legalName", "tin", "invoiceNumber"];
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
  const disabledRes = await page.request.post(
    BASE + `/api/firm-webhooks/${hook?.id}/disable`,
    { headers: CSRF },
  );
  const disabled =
    disabledRes.status() === 200 ? await disabledRes.json() : null;
  check(
    "delivery history records the delivered attempt; disable round-trips",
    history.some((d) => d.status === "delivered") && disabled?.active === false,
    `history rows: ${history.length}`,
  );

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
      if (probe.status() === 200 && Number((await probe.json()).fee?.total) > 0) {
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
