// The control journeys: maker-checker submission approval (governance) and
// collection accounts with the inbound settlement rail.
import {
  CSRF,
  DEMO_CLIENT_PARTY_ID,
  apiLogin,
  apiLogout,
  pollUntil,
} from "./shared.mjs";

// ---------- Governance: maker-checker submission approval --------------------
// The firm policy round-trip: the admin turns submit-approval ON, a staff
// submit without a second person's approval 409s APPROVAL_REQUIRED, the
// admin's approval (a DIFFERENT human) unlocks it, the staff submit answers
// 202 — and a finally restores the policy to OFF as its own check, because
// every later submit-dependent journey (credit note, integration layer) runs
// single-actor and would break against a policy left on.
//
// The probe draft GOV-9001 uses a number outside every pinned namespace
// (INV-100*, BILL-2001, KAN/NDP/LBR-*, CN-*, E2E-*). It leaves the journey
// `submitted` and stamps in the background, which disturbs nothing: the
// credit-note journey targets the OLDEST stamped demo-client invoice
// (createdAt asc — the boot-seeded INV-1003 always precedes GOV-9001), and
// the integration journey only patterns party ids off the book's first
// demo-client invoice regardless of status.
async function journeyGovernance(page, BASE, check) {
  const BUYER = "55555555-5555-4555-8555-555555555555"; // Zenith Retail

  try {
    await apiLogin(page, BASE, "demo.admin@meridianiq.example");
    const onRes = await page.request.put(BASE + "/api/firm/policies", {
      data: { submitApprovalRequired: true },
      headers: CSRF,
    });
    const onBody = onRes.status() === 200 ? await onRes.json() : null;
    check(
      "firm admin turns the submit-approval policy on",
      onRes.status() === 200 && onBody?.submitApprovalRequired === true,
      `status ${onRes.status()}`,
    );

    // Staff: fresh draft → validate → submit refuses. DomainError serializes
    // as {error: message} (no code field), so the check matches the guard's
    // message text.
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");
    const createdRes = await page.request.post(BASE + "/api/invoices", {
      data: {
        supplierPartyId: DEMO_CLIENT_PARTY_ID,
        buyerPartyId: BUYER,
        invoiceNumber: "GOV-9001",
        issueDate: new Date().toISOString().slice(0, 10),
        lines: [
          {
            description: "Governance probe goods",
            quantity: "1",
            unitPrice: "50000",
            vatRate: "0.075",
          },
        ],
      },
      headers: CSRF,
    });
    const invoiceId =
      createdRes.status() === 201 ? (await createdRes.json()).invoice?.id : null;
    const validateRes = await page.request.post(
      BASE + `/api/invoices/${invoiceId}/validate`,
      { headers: CSRF },
    );
    const blockedRes = await page.request.post(
      BASE + `/api/invoices/${invoiceId}/submit`,
      { headers: CSRF },
    );
    const blockedBody = await blockedRes.json().catch(() => null);
    check(
      "submit without a second person's approval answers 409 APPROVAL_REQUIRED",
      createdRes.status() === 201 &&
        validateRes.status() === 200 &&
        blockedRes.status() === 409 &&
        String(blockedBody?.error ?? "").includes("approval"),
      `create ${createdRes.status()}, validate ${validateRes.status()}, submit ${blockedRes.status()}`,
    );

    // A DIFFERENT human approves — evidence row, 201.
    await apiLogin(page, BASE, "demo.admin@meridianiq.example");
    const approveRes = await page.request.post(
      BASE + `/api/invoices/${invoiceId}/approve`,
      { headers: CSRF },
    );
    check(
      "a colleague records a submission approval (201)",
      approveRes.status() === 201,
      `status ${approveRes.status()}`,
    );

    // The original submitter retries: a live approval by ANOTHER user now
    // satisfies the guard.
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");
    const submitRes = await page.request.post(
      BASE + `/api/invoices/${invoiceId}/submit`,
      { headers: CSRF },
    );
    check(
      "approved invoice submits (202) under the policy",
      submitRes.status() === 202,
      `status ${submitRes.status()}`,
    );
  } finally {
    // MUST run even when a check above failed or threw: a policy left on
    // would break every later single-actor submit. The restore is itself a
    // check so a silent failure here can never masquerade as a pass.
    await apiLogin(page, BASE, "demo.admin@meridianiq.example");
    const offRes = await page.request.put(BASE + "/api/firm/policies", {
      data: { submitApprovalRequired: false },
      headers: CSRF,
    });
    const offBody = offRes.status() === 200 ? await offRes.json() : null;
    check(
      "submit-approval policy restored to off",
      offRes.status() === 200 && offBody?.submitApprovalRequired === false,
      `status ${offRes.status()}`,
    );
    await apiLogout(page, BASE);
  }
}

// ---------- Collection accounts: provision + the inbound settlement rail -----
// Provision a collection account (firm-staff plumbing, statement.write) and
// prove the fail-closed inbound webhook (run.mjs sets COLLECTION_WEBHOOK_TOKEN
// on the api-server env and threads the same value in here as hookToken;
// unset would 404 the whole rail) settles the matched receivable via an
// append-only collection_account settlement event.
//
// TARGET CHOICE — the settlement must move a SEEDED, STAMPED invoice to
// `settled` without disturbing any later journey. INV-1003 is out: it is the
// credit-note journey's target (the oldest stamped demo-client invoice must
// still read `stamped` when that journey picks it). LBR-4002 (Lagos
// BuildRight — a sibling client the same demo firm engages, stamped in the
// seed) is referenced by NO other journey and no seed expectation, so the
// account is provisioned for the BuildRight party and the payment binds to
// LBR-4002 — no fresh invoice or stamping wait needed. Deliberately NOT
// restored (the payables-journey exception): settlement events are append-only
// evidence. A rerun on a kept database still passes: the settled invoice no
// longer binds (the webhook silently records nothing), but the first run's
// settlement event and status satisfy both polls.
async function journeyCollections(page, BASE, check, hookToken) {
  const BUILD_CLIENT = "cb000004-0000-4000-8000-0000000000b4"; // Lagos BuildRight

  await apiLogin(page, BASE, "demo.admin@meridianiq.example");

  const createdRes = await page.request.post(
    BASE + "/api/collection-accounts",
    {
      data: { clientPartyId: BUILD_CLIENT, label: "E2E collections" },
      headers: CSRF,
    },
  );
  const account = createdRes.status() === 201 ? await createdRes.json() : null;
  check(
    "collection account provisions with a CA- reference",
    createdRes.status() === 201 &&
      (account?.accountReference ?? "").startsWith("CA-") &&
      account?.active === true,
    `status ${createdRes.status()}`,
  );

  const book = await (await page.request.get(BASE + "/api/invoices")).json();
  const target = book.find((i) => i.invoiceNumber === "LBR-4002");

  // Machine-rail probes ride plain fetch (cookie-free — the shared token is
  // the whole credential, the payment-confirm rail's posture). Wrong token:
  // 401, proving the rail is LIT but guarded (an unset env would 404).
  const badToken = await fetch(BASE + "/api/collections/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "x-op-token": "wrong-token" },
    body: JSON.stringify({
      accountReference: account?.accountReference ?? "CA-MISSING",
      amount: "1.00",
      invoiceNumber: "LBR-4002",
    }),
  });
  check(
    "inbound collection rail refuses a wrong token (401)",
    badToken.status === 401,
    `status ${badToken.status}`,
  );

  const inbound = await fetch(BASE + "/api/collections/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "x-op-token": hookToken },
    body: JSON.stringify({
      accountReference: account?.accountReference ?? "CA-MISSING",
      amount: target?.grandTotal ?? "0.00",
      invoiceNumber: "LBR-4002",
      reference: "E2E-COLLECT-1",
    }),
  });
  // The event + CAS commit BEFORE the 202 answers; the short poll is only
  // insurance, not a required drain.
  const eventSeen =
    inbound.status === 202 &&
    (await pollUntil(
      async () => {
        const r = await page.request.get(
          BASE + `/api/invoices/${target?.id}/settlements`,
        );
        if (r.status() !== 200) return false;
        return (await r.json()).some((s) => s.source === "collection_account");
      },
      { tries: 5, delayMs: 500, page },
    ));
  check(
    "inbound payment (202) records a collection_account settlement event",
    eventSeen,
    `inbound status ${inbound.status}`,
  );

  const invRes = await page.request.get(BASE + `/api/invoices/${target?.id}`);
  const settled =
    invRes.status() === 200 &&
    (await invRes.json()).invoice.status === "settled";
  check("matched receivable settles (stamped → settled CAS)", settled);

  await apiLogout(page, BASE);
}

export { journeyGovernance, journeyCollections };
