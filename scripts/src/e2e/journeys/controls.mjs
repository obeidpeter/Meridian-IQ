// The control journeys: maker-checker submission approval (governance),
// collection accounts with the inbound settlement rail, the Clerk
// proposed-actions + standing-approval (automation) round-trip, the Notice
// Desk obligations spine, the Filing Desk register walk, and the WHT Desk
// (category → remittance schedule → credit-note walk).
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

    // The backtest evidence (round 36): a firm read over the same ledgers
    // this journey is writing — four kinds in fixed order, act-now counting
    // at least the overdue draft just created. Flag-independent by design
    // (evidence exists precisely to justify lighting flags).
    const evidenceRes = await page.request.get(
      BASE + "/api/clerk/automation-evidence",
    );
    const evidence =
      evidenceRes.status() === 200 ? await evidenceRes.json() : null;
    check(
      "automation evidence backtests the four kinds with an act-now cohort",
      (evidence?.kinds ?? []).map((k) => k.kind).join(",") ===
        "reconcile_matches,submit_overdue,retry_failed,draft_recurring" &&
        (evidence?.kinds ?? []).every(
          (k) => k.sample >= 0 && typeof k.note === "string",
        ) &&
        (evidence?.kinds?.[1]?.pending ?? 0) >= 1,
      `status ${evidenceRes.status()}, pending ${evidence?.kinds?.[1]?.pending}`,
    );

    // The per-client twin (round 37): the same backtest scoped to the demo
    // client — the grant dialogs' read. The backdated draft above is this
    // client's, so its act-now cohort must see it.
    const clientEvRes = await page.request.get(
      BASE +
        `/api/clerk/client-automation-evidence?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const clientEv =
      clientEvRes.status() === 200 ? await clientEvRes.json() : null;
    check(
      "client-scoped automation evidence sees the client's own backlog",
      (clientEv?.kinds ?? []).length === 4 &&
        (clientEv?.kinds?.[1]?.pending ?? 0) >= 1,
      `status ${clientEvRes.status()}, pending ${clientEv?.kinds?.[1]?.pending}`,
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

// Notice Desk obligations: the deterministic spine only (record → list →
// month-end item → respond → close). The AI notice-extraction lane needs a
// live model provider, so it is covered by the DB-backed api-server suite,
// not here — exactly like invoice extraction.
async function journeyObligations(page, BASE, check) {
  // Due inside the 7-day due-soon window, never today (no boundary flake).
  const due = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const reference = `E2E/OBL/${Date.now()}`;
  let obligationId = null;

  try {
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");

    const created = await page.request.post(BASE + "/api/obligations", {
      data: {
        clientPartyId: DEMO_CLIENT_PARTY_ID,
        noticeType: "assessment",
        authority: "firs",
        reference,
        taxType: "vat",
        responseDueDate: due,
      },
      headers: CSRF,
    });
    const createdBody = created.ok() ? await created.json() : {};
    obligationId = createdBody.id ?? null;
    check(
      "firm staff records a paper notice as an open obligation",
      created.status() === 201 && createdBody.status === "open",
      `status ${created.status()}`,
    );

    const list = await page.request.get(
      BASE + `/api/obligations?clientPartyId=${DEMO_CLIENT_PARTY_ID}&status=open`,
    );
    const listBody = list.ok() ? await list.json() : { obligations: [] };
    check(
      "the open-obligations list carries the recorded notice",
      list.status() === 200 &&
        listBody.obligations.some((o) => o.reference === reference),
      `status ${list.status()}, ${listBody.obligations?.length ?? 0} rows`,
    );

    // Response Desk, deterministic halves only: without a model provider the
    // letter draft MUST still answer (template fallback — the digest-posture
    // claim), and the bundle PDF is zero-model by construction.
    const draft = await page.request.post(
      BASE + `/api/obligations/${obligationId}/response-draft`,
      { data: {}, headers: CSRF },
    );
    const draftBody = draft.ok() ? await draft.json() : {};
    check(
      "response letter drafts without a provider (template fallback)",
      draft.status() === 200 &&
        draftBody.source === "template" &&
        typeof draftBody.letter === "string" &&
        draftBody.letter.includes(reference),
      `status ${draft.status()}, source ${draftBody.source ?? "-"}`,
    );

    const pack = await page.request.get(
      BASE + `/api/obligation-response-pack?obligationId=${obligationId}`,
    );
    const packBody = pack.status() === 200 ? await pack.body() : null;
    check(
      "response bundle renders a PDF",
      pack.status() === 200 &&
        (pack.headers()["content-type"] ?? "").startsWith("application/pdf") &&
        packBody?.subarray(0, 4).toString() === "%PDF",
      `status ${pack.status()}`,
    );

    const close = await page.request.get(
      BASE + `/api/month-end-close?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const closeBody = close.ok() ? await close.json() : { items: [] };
    const oblItem = (closeBody.items ?? []).find(
      (i) => i.key === "open_obligations",
    );
    check(
      "month-end close flags the open obligation for attention",
      close.status() === 200 &&
        oblItem !== undefined &&
        oblItem.status === "attention" &&
        oblItem.count >= 1,
      oblItem ? `${oblItem.status}, count ${oblItem.count}` : "item missing",
    );

    const responded = await page.request.post(
      BASE + `/api/obligations/${obligationId}/status`,
      { data: { status: "responded" }, headers: CSRF },
    );
    const respondedBody = responded.ok() ? await responded.json() : {};
    check(
      "the obligation moves to responded",
      responded.status() === 200 && respondedBody.status === "responded",
      `status ${responded.status()}`,
    );
  } finally {
    // Restore: close the obligation so later runs and journeys never see a
    // lingering open deadline for the demo client — and the restore is
    // itself a check, so a silent failure can't masquerade as a pass.
    let closedOk = false;
    if (obligationId) {
      const closed = await page.request.post(
        BASE + `/api/obligations/${obligationId}/status`,
        { data: { status: "closed" }, headers: CSRF },
      );
      closedOk = closed.status() === 200;
    }
    check(
      "restore: the e2e obligation is closed",
      closedOk,
      obligationId ? "" : "no obligation id captured",
    );
    await apiLogout(page, BASE);
  }
}

// ---------- Filing Desk: mint the register, walk a return to filed -----------
// The returns register's deterministic spine: sync mints the current
// period's VAT + PAYE rows for every engaged client (idempotent — {minted}
// is 0 on a same-period re-run), then one row walks upcoming → prepared →
// filed, with "filed" carrying the filed date and the authority's receipt
// reference as evidence. The platform records the filing; it never files.
//
// RESTORE NOTE — none needed, deliberately: filed rows are terminal,
// periodic EVIDENCE (the next period mints fresh rows; no later journey
// reads this register). But re-runs against a kept database must stay
// green, so the walk is skip-or-pass: a VAT row already filed by an earlier
// run hands the walk to the PAYE row, and with BOTH already filed the two
// walk checks pass vacuously with an honest "already filed — earlier run"
// detail (the re-list check still proves the filed state for real).
async function journeyFilings(page, BASE, check) {
  // The register's current period is the PREVIOUS month — July's VAT return
  // and PAYE remittance fall due in August.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;

  try {
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");

    const sync = await page.request.post(BASE + "/api/filings/sync", {
      headers: CSRF,
    });
    const syncBody = sync.ok() ? await sync.json() : {};
    check(
      "filings sync mints the current period's register (idempotent)",
      sync.status() === 200 &&
        typeof syncBody.minted === "number" &&
        syncBody.minted >= 0,
      `status ${sync.status()}, minted ${syncBody.minted ?? "-"}`,
    );

    const list = await page.request.get(
      BASE + `/api/filings?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const rows = list.ok() ? (await list.json()).filings : [];
    const vatRow = rows.find(
      (f) => f.taxType === "vat" && f.period === period,
    );
    const payeRow = rows.find(
      (f) => f.taxType === "paye" && f.period === period,
    );
    check(
      "the register lists the period's VAT return and PAYE remittance",
      list.status() === 200 && rows.length >= 2 && vatRow !== undefined,
      `status ${list.status()}, ${rows.length} rows, period ${period}`,
    );

    // Month-end close reads the register BEFORE the walk: the freshly-minted
    // rows are unfiled, so open_filings flags them for attention. Against a
    // kept database an earlier run may already have filed both demo rows —
    // the item then honestly reads clear (the skip-or-pass posture).
    const bothFiled =
      vatRow?.status === "filed" && payeRow?.status === "filed";
    const close = await page.request.get(
      BASE + `/api/month-end-close?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const closeBody = close.ok() ? await close.json() : { items: [] };
    const filItem = (closeBody.items ?? []).find(
      (i) => i.key === "open_filings",
    );
    check(
      "month-end close flags the unfiled returns for attention",
      close.status() === 200 &&
        filItem !== undefined &&
        (bothFiled
          ? filItem.status === "clear"
          : filItem.status === "attention" && filItem.count >= 1),
      filItem
        ? bothFiled
          ? "already filed — earlier run"
          : `${filItem.status}, count ${filItem.count}`
        : "item missing",
    );

    // The firm cockpit: one row per client for the current period, with the
    // demo client among them. State-independent except totals.unfiled, which
    // an earlier run's filed demo rows can no longer vouch for — that clause
    // drops in the already-filed case.
    const matrixRes = await page.request.get(
      BASE + "/api/console/filing-matrix",
    );
    const matrix = matrixRes.ok()
      ? await matrixRes.json()
      : { rows: [], totals: {} };
    check(
      "the filing cockpit shows every client's period status",
      matrixRes.status() === 200 &&
        matrix.rows.length >= 1 &&
        matrix.rows.some((r) => r.clientPartyId === DEMO_CLIENT_PARTY_ID) &&
        (bothFiled || matrix.totals.unfiled >= 1),
      `status ${matrixRes.status()}, ${matrix.rows?.length ?? 0} rows, unfiled ${matrix.totals?.unfiled ?? "-"}`,
    );

    // Skip-or-pass target choice: prefer the VAT row; already filed by an
    // earlier run, the walk moves to the PAYE row; both filed leaves nothing
    // to walk — the earlier run already proved it.
    const target =
      vatRow && vatRow.status !== "filed"
        ? vatRow
        : payeRow && payeRow.status !== "filed"
          ? payeRow
          : null;

    // Upcoming → prepared. A target already prepared (a crashed earlier run)
    // skips the move the same honest way rather than re-sending it.
    let prepared = null;
    if (target && target.status === "upcoming") {
      const res = await page.request.post(
        BASE + `/api/filings/${target.id}/status`,
        { data: { status: "prepared" }, headers: CSRF },
      );
      prepared = { status: res.status(), body: res.ok() ? await res.json() : {} };
    }
    check(
      "the return marks prepared",
      target === null || target.status !== "upcoming"
        ? true
        : prepared.status === 200 && prepared.body.status === "prepared",
      target === null
        ? "already filed — earlier run"
        : target.status !== "upcoming"
          ? "already prepared — earlier run"
          : `status ${prepared.status}`,
    );

    // Prepared → filed, with the evidence trio the contract wants ("filed"
    // requires filedDate; the reference is the authority's receipt number).
    let filed = null;
    if (target) {
      const res = await page.request.post(
        BASE + `/api/filings/${target.id}/status`,
        {
          data: {
            status: "filed",
            filedDate: new Date().toISOString().slice(0, 10),
            filedReference: "E2E/FIL/" + Date.now(),
          },
          headers: CSRF,
        },
      );
      filed = { status: res.status(), body: res.ok() ? await res.json() : {} };
    }
    check(
      "the prepared return marks filed with date and reference",
      target === null
        ? true
        : filed.status === 200 &&
            filed.body.status === "filed" &&
            Boolean(filed.body.filedReference),
      target === null
        ? "already filed — earlier run"
        : `status ${filed.status}`,
    );

    // The walk survives a re-read: the row (this run's, or the earlier
    // run's VAT row) reads filed in the filtered list.
    const walked = target ?? vatRow;
    const relist = await page.request.get(
      BASE + `/api/filings?clientPartyId=${DEMO_CLIENT_PARTY_ID}&status=filed`,
    );
    const relistRows = relist.ok() ? (await relist.json()).filings : [];
    check(
      "a re-list shows the walked return filed",
      relist.status() === 200 &&
        relistRows.some((f) => f.id === walked?.id && f.status === "filed"),
      `status ${relist.status()}, ${relistRows.length} filed rows`,
    );
  } finally {
    await apiLogout(page, BASE);
  }
}

// ---------- WHT Desk: category → remittance → credit-note walk ---------------
// The withholding spine end-to-end: a WHT-categorised BILL (supplier = the
// seeded vendor, buyer = the demo client, issued in the previous Lagos
// period) makes filings sync mint the period's "wht" register row and puts
// the bill on the remittance schedule; a WHT-categorised RECEIVABLE takes a
// recorded deduction that opens an awaiting_note credit, which the credit
// note's reference + date walk to note_received; and month-end close carries
// the wht_credits chase item. Every probe document uses a Date.now() number
// (WHT-*/WHT-R-*, outside every pinned namespace), so the idempotent
// POST /api/wht/credits can never hand back an earlier run's already-noted
// row — the walk is deterministic per run, no kept-DB skip needed. Both
// probes stay DRAFT forever (never submitted), so the credit-note journey's
// oldest-STAMPED target pick and the integration journey's party patterning
// are undisturbed.
async function journeyWht(page, BASE, check) {
  const BUYER = "55555555-5555-4555-8555-555555555555"; // Zenith Retail
  // journeyFilings' period computation: the register's current period is the
  // PREVIOUS month.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const today = new Date().toISOString().slice(0, 10);

  try {
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");

    // A NEW previous-period bill with a human-picked category. The seeded
    // vendor party is discovered from the existing bills ledger rather than
    // pinned — the seed owns that id.
    const billsRes = await page.request.get(
      BASE + `/api/bills?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const bills = billsRes.ok() ? await billsRes.json() : [];
    const vendorPartyId = bills[0]?.supplierPartyId ?? null;
    const billNumber = `WHT-${Date.now()}`;
    const createdBill = vendorPartyId
      ? await createDraftInvoice(page, BASE, {
          supplierPartyId: vendorPartyId,
          buyerPartyId: DEMO_CLIENT_PARTY_ID,
          invoiceNumber: billNumber,
          issueDate: `${period}-15`,
          description: "WHT probe professional services",
          unitPrice: "200000",
          whtCategory: "services_5",
        })
      : { status: 0, invoiceId: null };
    const billDetailRes = createdBill.invoiceId
      ? await page.request.get(BASE + `/api/invoices/${createdBill.invoiceId}`)
      : null;
    const billDetail = billDetailRes?.ok() ? await billDetailRes.json() : null;
    check(
      "a bill carries its WHT category",
      createdBill.status === 201 &&
        billDetail?.invoice?.whtCategory === "services_5",
      vendorPartyId
        ? `create ${createdBill.status}, whtCategory ${billDetail?.invoice?.whtCategory ?? "-"}`
        : "no seeded bill to discover the vendor from",
    );

    // Sync now that the period holds a WHT-categorised bill: the register
    // mints the client's "wht" remittance row (idempotent like the vat/paye
    // mint; status any — an earlier run may already have walked it).
    const sync = await page.request.post(BASE + "/api/filings/sync", {
      headers: CSRF,
    });
    const whtList = await page.request.get(
      BASE + `/api/filings?clientPartyId=${DEMO_CLIENT_PARTY_ID}&taxType=wht`,
    );
    const whtRows = whtList.ok() ? (await whtList.json()).filings : [];
    const whtRow = whtRows.find((f) => f.period === period);
    check(
      "filings sync mints the WHT remittance row",
      sync.status() === 200 &&
        whtList.status() === 200 &&
        whtRow !== undefined,
      `sync ${sync.status()}, list ${whtList.status()}, ${whtRows.length} wht rows, period ${period}`,
    );

    // The remittance schedule lists the bill, and the total the server
    // computed parses positive (the frontends never do this arithmetic).
    const remitRes = await page.request.get(
      BASE +
        `/api/wht/remittance?clientPartyId=${DEMO_CLIENT_PARTY_ID}&period=${period}`,
    );
    const remit = remitRes.ok() ? await remitRes.json() : null;
    check(
      "the remittance schedule lists the bill",
      remitRes.status() === 200 &&
        (remit?.rows ?? []).some((r) => r.invoiceNumber === billNumber) &&
        Number(remit?.totals?.whtAmount) > 0,
      `status ${remitRes.status()}, ${remit?.rows?.length ?? 0} rows, whtAmount ${remit?.totals?.whtAmount ?? "-"}`,
    );

    // The credit side: a categorised RECEIVABLE (supplier = the demo
    // client) takes a recorded deduction — the credit opens awaiting its
    // note, with the amount computed server-side from the category's rate.
    const recvNumber = `WHT-R-${Date.now()}`;
    const createdRecv = await createDraftInvoice(page, BASE, {
      supplierPartyId: DEMO_CLIENT_PARTY_ID,
      buyerPartyId: BUYER,
      invoiceNumber: recvNumber,
      issueDate: today,
      description: "WHT probe consulting",
      unitPrice: "150000",
      whtCategory: "services_5",
    });
    const creditRes = createdRecv.invoiceId
      ? await page.request.post(BASE + "/api/wht/credits", {
          data: { invoiceId: createdRecv.invoiceId, deductedDate: today },
          headers: CSRF,
        })
      : null;
    const credit =
      creditRes && creditRes.status() === 201 ? await creditRes.json() : null;
    check(
      "a recorded deduction opens a credit",
      createdRecv.status === 201 &&
        creditRes?.status() === 201 &&
        credit?.status === "awaiting_note" &&
        Number(credit?.amount) > 0,
      `create ${createdRecv.status}, credit ${creditRes?.status() ?? "-"}, status ${credit?.status ?? "-"}, amount ${credit?.amount ?? "-"}`,
    );

    // The ledger lists it with the chase totals.
    const ledgerRes = await page.request.get(
      BASE + `/api/wht/credits?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const ledger = ledgerRes.ok() ? await ledgerRes.json() : null;
    check(
      "the credit ledger lists it with totals",
      ledgerRes.status() === 200 &&
        (ledger?.credits ?? []).some((c) => c.id === credit?.id) &&
        (ledger?.totals?.awaitingNote ?? 0) >= 1,
      `status ${ledgerRes.status()}, ${ledger?.credits?.length ?? 0} credits, awaitingNote ${ledger?.totals?.awaitingNote ?? "-"}`,
    );

    // The credit note's reference + date walk it forward (forward-only —
    // this run's own fresh credit, so never already note_received).
    const noteRes = credit
      ? await page.request.post(BASE + `/api/wht/credits/${credit.id}/note`, {
          data: { noteReference: "WHT-CN-e2e", noteDate: today },
          headers: CSRF,
        })
      : null;
    const noted = noteRes?.ok() ? await noteRes.json() : null;
    check(
      "the credit note evidence walks it forward",
      noteRes?.status() === 200 && noted?.status === "note_received",
      `status ${noteRes?.status() ?? "-"}, ${noted?.status ?? "-"}`,
    );

    // Month-end close carries the wht_credits chase item. This run just
    // closed ITS OWN credit, but earlier runs (or the reconciliation
    // journey's short-pay matches) may hold others open — so the item's
    // presence is the hard assertion, and its status is checked against
    // what the ledger honestly holds right now (the journeyFilings
    // skip-or-pass posture).
    const afterRes = await page.request.get(
      BASE + `/api/wht/credits?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const after = afterRes.ok() ? await afterRes.json() : null;
    const stillAwaiting = (after?.totals?.awaitingNote ?? 0) >= 1;
    const close = await page.request.get(
      BASE + `/api/month-end-close?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const closeBody = close.ok() ? await close.json() : { items: [] };
    const whtItem = (closeBody.items ?? []).find(
      (i) => i.key === "wht_credits",
    );
    check(
      "month-end close carries the WHT chase item",
      close.status() === 200 &&
        whtItem !== undefined &&
        (stillAwaiting
          ? whtItem.status === "attention" && whtItem.count >= 1
          : whtItem.status === "clear"),
      whtItem
        ? `${whtItem.status}, count ${whtItem.count}, awaitingNote ${after?.totals?.awaitingNote ?? "-"}`
        : "item missing",
    );
  } finally {
    await apiLogout(page, BASE);
  }
}

// ---------- Compliance Profile: assert facts, mint the annual layer ----------
// The statutory-profile spine: a HUMAN at the firm asserts the per-client
// facts (VAT-registered, PAYE employer, financial year end, incorporation
// date); the asserted profile narrows the monthly minting honestly and
// unlocks the ANNUAL returns (CIT due 6 months after the FYE; CAC annual due
// 30 June; the employer annual return due 31 January), whose overdue rows
// produce an ESTIMATED exposure figure — never a "penalty owed".
//
// INTERPLAY — journeyFilings (earlier in the run, and every future run
// against a kept database) asserts the demo client's vat+paye monthly rows
// mint, so this journey's PUT deliberately sets vatRegistered AND
// payeEmployer TRUE: the assertion keeps the mint-both behaviour instead of
// narrowing a row away. fyeMonth 12 pins the December FYE whose CIT return
// falls due mid-year.
//
// RESTORE NOTE — none needed, deliberately: the profile PUT is an idempotent
// upsert (every run re-asserts the same facts) and the annual filing rows
// are periodic evidence like the monthly ones (idempotent mint; no journey
// ever walks them to filed). Check 1 is the one kept-DB fork: a fresh seed
// answers {profile: null}, a kept database echoes the earlier run's
// assertion (skip-or-pass).
async function journeyProfile(page, BASE, check) {
  try {
    await apiLogin(page, BASE, "demo.staff@meridianiq.example");

    // Fresh DB: no profile yet. Kept DB: the earlier run's assertion echoes
    // back (vatRegistered true is the fact every run asserts) — skip-or-pass.
    const before = await page.request.get(
      BASE + `/api/clients/${DEMO_CLIENT_PARTY_ID}/compliance-profile`,
    );
    const beforeBody = before.ok() ? await before.json() : {};
    check(
      "the profile starts unasserted (or echoes a prior run's assertion)",
      before.status() === 200 &&
        (beforeBody.profile === null ||
          beforeBody.profile?.vatRegistered === true),
      `status ${before.status()}, profile ${
        beforeBody.profile === null ? "null" : "asserted (earlier run)"
      }`,
    );

    // The firm asserts the facts; the upsert echoes them back.
    const put = await page.request.put(
      BASE + `/api/clients/${DEMO_CLIENT_PARTY_ID}/compliance-profile`,
      {
        data: {
          vatRegistered: true,
          payeEmployer: true,
          fyeMonth: 12,
          incorporationDate: "2020-03-15",
        },
        headers: CSRF,
      },
    );
    const profile = put.ok() ? await put.json() : {};
    check(
      "the firm asserts the statutory profile",
      put.status() === 200 &&
        profile.vatRegistered === true &&
        profile.payeEmployer === true &&
        profile.fyeMonth === 12 &&
        profile.incorporationDate === "2020-03-15",
      `status ${put.status()}, fyeMonth ${profile.fyeMonth ?? "-"}`,
    );

    // The firm-wide summary (the portfolio checklist's evidence) counts it.
    const summaryRes = await page.request.get(
      BASE + "/api/compliance-profiles/summary",
    );
    const summary = summaryRes.ok() ? await summaryRes.json() : {};
    check(
      "the summary counts the profiled client",
      summaryRes.status() === 200 &&
        summary.clients >= 1 &&
        summary.profiled >= 1 &&
        summary.profiled <= summary.clients,
      `status ${summaryRes.status()}, ${summary.profiled ?? "-"}/${summary.clients ?? "-"} profiled`,
    );

    // Sync now mints the annual layer for the profiled client: the CIT
    // return for the December FYE (period ends "-12") and the employer
    // annual return. Idempotent like the monthly mint — a kept DB re-mints
    // nothing but the rows are still there to list.
    const sync = await page.request.post(BASE + "/api/filings/sync", {
      headers: CSRF,
    });
    const citList = await page.request.get(
      BASE + `/api/filings?clientPartyId=${DEMO_CLIENT_PARTY_ID}&taxType=cit`,
    );
    const citRows = citList.ok() ? (await citList.json()).filings : [];
    const citRow = citRows.find((f) => f.period.endsWith("-12"));
    const payeAnnualList = await page.request.get(
      BASE +
        `/api/filings?clientPartyId=${DEMO_CLIENT_PARTY_ID}&taxType=paye_annual`,
    );
    const payeAnnualRows = payeAnnualList.ok()
      ? (await payeAnnualList.json()).filings
      : [];
    check(
      "sync mints the annual returns from the profile",
      sync.status() === 200 &&
        citList.status() === 200 &&
        citRow !== undefined &&
        payeAnnualList.status() === 200 &&
        payeAnnualRows.length >= 1,
      `sync ${sync.status()}, ${citRows.length} cit rows, ${payeAnnualRows.length} paye_annual rows`,
    );

    // Structural due-date check only — the arithmetic (FYE + 6 months on the
    // Lagos calendar) is the backend unit tests' job; here the row just has
    // to carry a real date that falls after its period opens.
    check(
      "the annual returns carry real due dates",
      citRow !== undefined &&
        /^\d{4}-\d{2}-\d{2}$/.test(citRow.dueDate ?? "") &&
        citRow.dueDate > `${citRow.period}-01`,
      citRow ? `period ${citRow.period}, due ${citRow.dueDate}` : "no cit row",
    );

    // The exposure figure. Deterministic on fresh AND kept databases: no
    // journey ever files an annual row, and with today's clock the freshly
    // minted pair is already overdue (the December-FYE CIT fell due
    // mid-2026, the employer annual return on 31 January 2026) — so rows
    // exist and the estimated total parses positive, outright.
    const expRes = await page.request.get(
      BASE +
        `/api/filing-penalty-exposure?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    const exposure = expRes.ok() ? await expRes.json() : {};
    check(
      "late annual returns surface an estimated exposure",
      expRes.status() === 200 &&
        (exposure.rows ?? []).length >= 1 &&
        Number(exposure.totalNgn) > 0,
      `status ${expRes.status()}, ${exposure.rows?.length ?? "-"} rows, total ${exposure.totalNgn ?? "-"}`,
    );
  } finally {
    await apiLogout(page, BASE);
  }
}

export {
  journeyGovernance,
  journeyCollections,
  journeyAutomation,
  journeyObligations,
  journeyFilings,
  journeyWht,
  journeyProfile,
};
