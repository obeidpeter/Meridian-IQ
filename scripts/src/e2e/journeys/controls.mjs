// The control journeys: maker-checker submission approval (governance),
// collection accounts with the inbound settlement rail, and the Clerk
// proposed-actions + standing-approval (automation) round-trip.
import {
  CSRF,
  DEMO_CLIENT_PARTY_ID,
  apiLogin,
  apiLogout,
  createDraftInvoice,
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
    const created = await createDraftInvoice(page, BASE, {
      supplierPartyId: DEMO_CLIENT_PARTY_ID,
      buyerPartyId: BUYER,
      invoiceNumber: "GOV-9001",
      issueDate: new Date().toISOString().slice(0, 10),
      description: "Governance probe goods",
      unitPrice: "50000",
    });
    const invoiceId = created.invoiceId;
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
      created.status === 201 &&
        validateRes.status() === 200 &&
        blockedRes.status() === 409 &&
        String(blockedBody?.error ?? "").includes("approval"),
      `create ${created.status}, validate ${validateRes.status()}, submit ${blockedRes.status()}`,
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

// ---------- Clerk automation: proposals, execute, standing approval ----------
// The advice→action rails end to end against the real stack: the operator
// lights the two opt-in flags (both seeded DARK — PL-02), a staff member sees
// a live submit_overdue proposal for a deliberately backdated draft, approves
// it through the execute route (the decision ledger records the batch), then
// grants / pauses / resumes / revokes a standing approval. The finally
// restores the seeded world as its own checks — the governance journey's
// restore-as-a-check discipline — because flags left lit would change what
// every later SME-dashboard render shows.
//
// PLACEMENT (index.mjs runs this after journeyCollections, before
// journeyStaffCreditNoteAndWorkflow) and why it disturbs nothing:
//  - AUTO-9001 uses a number outside every pinned namespace (INV-100*,
//    BILL-2001, KAN/NDP/LBR-*, CN-*, E2E-*, GOV-9001).
//  - AUTO-9001 leaves this journey `submitted` and stamps in the background,
//    exactly like GOV-9001: the credit-note journey targets the OLDEST
//    stamped demo-client invoice (bare GET /api/invoices is createdAt ASC),
//    and the boot-seeded INV-1003 always precedes an invoice created here.
//  - No later journey counts pending drafts: the lifecycle journey's
//    bulk-submit check only opens and cancels the dialog (no count
//    assertion), and the integration journey patterns party ids off the
//    FIRST demo-client invoice in the asc book (INV-1001, untouched — this
//    journey executes ONLY its own AUTO-9001, never the proposal's other
//    targets).
//  - No other journey reads or asserts clerk_actions/clerk_action_policies
//    (the operator-desk journey toggles `reconciliation`, via the UI).
//  - The action-policy sweep is atMostHourly and consumed its first tick at
//    boot while both flags were dark, so the grant below can never be
//    auto-run mid-journey by the background worker.
async function journeyAutomation(page, BASE, check) {
  const BUYER = "55555555-5555-4555-8555-555555555555"; // Zenith Retail
  const FLAG_KEYS = ["clerk_actions", "clerk_action_policies"];

  const setFlags = async (enabled) => {
    const statuses = [];
    for (const key of FLAG_KEYS) {
      const r = await page.request.patch(BASE + `/api/feature-flags/${key}`, {
        data: { enabled },
        headers: CSRF,
      });
      statuses.push(r.status());
    }
    return statuses;
  };

  try {
    // Operator lights both flags (seeded rows, so PATCH answers 204).
    await apiLogin(page, BASE, "ops@meridianiq.example");
    const onStatuses = await setFlags(true);
    check(
      "operator lights the clerk_actions + clerk_action_policies flags",
      onStatuses.every((s) => s === 204),
      `statuses ${onStatuses.join(", ")}`,
    );

    // Staff: a fresh draft backdated ~20 days — past the 7-day statutory
    // submission window, so the live submit_overdue proposal must pick it up
    // (alongside the seeded overdue INV-1001, which this journey never
    // touches).
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");
    const issueDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const created = await createDraftInvoice(page, BASE, {
      supplierPartyId: DEMO_CLIENT_PARTY_ID,
      buyerPartyId: BUYER,
      invoiceNumber: "AUTO-9001",
      issueDate,
      description: "Automation probe goods",
      unitPrice: "40000",
    });
    const invoiceId = created.invoiceId;
    const propRes = await page.request.get(
      BASE + `/api/clerk/action-proposals?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const proposals = propRes.status() === 200 ? await propRes.json() : null;
    const overdue = (proposals?.actions ?? []).find(
      (a) => a.kind === "submit_overdue",
    );
    check(
      "submit_overdue proposal lists the backdated AUTO-9001 draft",
      created.status === 201 &&
        (overdue?.targets ?? []).some((t) => t.invoiceId === invoiceId),
      `create ${created.status}, proposals ${propRes.status()}`,
    );

    // Approve exactly the one target: execute validates + submits it through
    // the ordinary per-invoice path and answers the durable decision row.
    const execRes = await page.request.post(
      BASE + "/api/clerk/action-proposals/execute",
      {
        data: {
          kind: "submit_overdue",
          invoiceIds: [invoiceId],
          clientPartyId: DEMO_CLIENT_PARTY_ID,
        },
        headers: CSRF,
      },
    );
    const decision =
      execRes.status() === 200 ? (await execRes.json()).decision : null;
    check(
      "approving the batch submits AUTO-9001 and records the decision",
      execRes.status() === 200 &&
        decision?.executedCount === 1 &&
        (decision?.targets ?? []).some(
          (t) => t.invoiceId === invoiceId && t.outcome === "submitted",
        ),
      `execute ${execRes.status()}, executedCount ${decision?.executedCount}`,
    );

    // Standing approval with a chosen per-run cap (the grant dialog's
    // "Daily limit" input; contract answers 200 with the new grant).
    const grantRes = await page.request.post(
      BASE + "/api/clerk/action-policies",
      {
        data: {
          kind: "submit_overdue",
          clientPartyId: DEMO_CLIENT_PARTY_ID,
          maxTargetsPerRun: 5,
        },
        headers: CSRF,
      },
    );
    const policy = grantRes.status() === 200 ? await grantRes.json() : null;
    check(
      "standing approval grants with maxTargetsPerRun 5",
      grantRes.status() === 200 &&
        policy?.maxTargetsPerRun === 5 &&
        policy?.kind === "submit_overdue" &&
        policy?.revokedAt === null,
      `status ${grantRes.status()}`,
    );

    // Lifecycle walk: pause (manual, reversible) → resume (pause cleared).
    const pauseRes = await page.request.post(
      BASE + `/api/clerk/action-policies/${policy?.id}/pause`,
      { headers: CSRF },
    );
    const paused = pauseRes.status() === 200 ? await pauseRes.json() : null;
    const resumeRes = await page.request.post(
      BASE + `/api/clerk/action-policies/${policy?.id}/resume`,
      { headers: CSRF },
    );
    const resumed = resumeRes.status() === 200 ? await resumeRes.json() : null;
    check(
      "grant pauses (manual) and resumes clean",
      Boolean(paused?.pausedAt) &&
        paused?.pausedReason === "manual" &&
        resumed !== null &&
        resumed.pausedAt === null,
      `pause ${pauseRes.status()}, resume ${resumeRes.status()}`,
    );

    // Revoke is permanent evidence: the row survives with revokedAt set.
    const revokeRes = await page.request.post(
      BASE + `/api/clerk/action-policies/${policy?.id}/revoke`,
      { headers: CSRF },
    );
    const revoked = revokeRes.status() === 200 ? await revokeRes.json() : null;
    check(
      "revoke retires the grant permanently (revokedAt set)",
      revokeRes.status() === 200 && Boolean(revoked?.revokedAt),
      `status ${revokeRes.status()}`,
    );
  } finally {
    // MUST run even when a check above failed or threw. Two restores:
    //  1. Revoke any live grant for the demo client (idempotent — revoking
    //     the already-revoked grant, or nothing, is a no-op): a live policy
    //     left behind would let the daily sweep submit demo drafts on a
    //     rerun against a kept database.
    //  2. As the operator, restore BOTH flags to their seeded dark state —
    //     itself a check, so a silent restore failure can never masquerade
    //     as a pass. (Revocation deliberately runs FIRST: grants stay
    //     pausable/revocable while the flags are dark, but the order keeps
    //     the finally independent of that guarantee.)
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");
    const listRes = await page.request.get(
      BASE + `/api/clerk/action-policies?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const live =
      listRes.status() === 200
        ? (await listRes.json()).policies.filter((p) => !p.revokedAt)
        : [];
    for (const p of live) {
      await page.request.post(
        BASE + `/api/clerk/action-policies/${p.id}/revoke`,
        { headers: CSRF },
      );
    }
    await apiLogin(page, BASE, "ops@meridianiq.example");
    const offStatuses = await setFlags(false);
    check(
      "clerk automation flags restored to dark",
      offStatuses.every((s) => s === 204),
      `statuses ${offStatuses.join(", ")}`,
    );
    await apiLogout(page, BASE);
  }
}

export { journeyGovernance, journeyCollections, journeyAutomation };
