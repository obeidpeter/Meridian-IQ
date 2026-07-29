// The money journeys: supplier bills (payables) and the VAT position page
// plus the monthly compliance pack.
import {
  CSRF,
  DEMO_CLIENT_PARTY_ID,
  apiLogin,
  apiLogout,
  pollUntil,
  signIn,
  signOutFromApp,
} from "./shared.mjs";

// ---------- SME staff: supplier bills (payables) ----------
// The payables round against the seeded vendor bill (BILL-2001 from "Lagos
// Packaging Supplies Ltd", buyer = the demo client): the bills list and page,
// the payables dashboard summary, evidence-only payment flags (payer_flag
// settlement events — the derived payStatus moves, the bill's invoice status
// never transitions), and the orientation guard that refuses to stamp a
// supplier document. Signs in as demo.staff (the SME workflow account) and
// signs out after; it creates no invoices, so the credit-note journey's
// target pick is undisturbed. One deliberate non-restore: payment flags are
// append-only settlement evidence, so the seeded bill stays "paid" after this
// run — fine for the standard fresh-seed run (run.mjs requires a scratch
// database), but a rerun on a kept database sees payStatus "paid" up front.
async function journeyPayables(page, BASE, check) {
  const billFromList = async () => {
    const r = await page.request.get(
      BASE + `/api/bills?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
    );
    if (r.status() !== 200) return null;
    return (await r.json()).find((b) => b.invoiceNumber === "BILL-2001") ?? null;
  };

  await signIn(page, BASE, "button-demo-demo.staff", "**/app/**");

  // The bills ledger lists the seeded vendor bill. payStatus derives from
  // settlement evidence ONLY, and the fresh seed has none, so it is open.
  const bill = await billFromList();
  check(
    "bills API lists the seeded vendor bill with payStatus open",
    bill?.payStatus === "open",
    bill ? `payStatus ${bill.payStatus}` : "BILL-2001 not in the list",
  );

  // The SME Bills page renders it.
  await page.goto(BASE + "/app/bills", { waitUntil: "networkidle" });
  await page.waitForSelector("text=BILL-2001", { timeout: 15000 });
  check("SME bills page renders the seeded bill", true);

  // The payables summary — read while the bill is still unpaid, because
  // committed outflows only count bills without payment evidence.
  const payablesRes = await page.request.get(
    BASE + `/api/dashboard/payables?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
  );
  const payables =
    payablesRes.status() === 200 ? await payablesRes.json() : null;
  check(
    "payables summary carries a group with a positive committed total",
    (payables?.groups ?? []).some((g) => Number(g.total?.amount) > 0),
    `status ${payablesRes.status()}`,
  );

  // Payment flags are settlement EVIDENCE (source payer_flag): each flag is
  // a 201-created settlement event the derived payStatus follows — the
  // underlying invoice status never transitions.
  const flagAndSee = async (status) => {
    const flagged = await page.request.post(
      BASE + `/api/bills/${bill?.invoiceId}/payment-flag`,
      { data: { status }, headers: CSRF },
    );
    const seen = await pollUntil(
      async () => (await billFromList())?.payStatus === status,
      { tries: 5, delayMs: 500, page },
    );
    return flagged.status() === 201 && seen;
  };
  check(
    "scheduled payment flag derives payStatus scheduled",
    await flagAndSee("scheduled"),
  );
  check("paid payment flag derives payStatus paid", await flagAndSee("paid"));

  // The orientation guard: a bill's supplier is not an engaged client, so
  // validate and submit both refuse (409 NOT_SUBMITTABLE) — a supplier
  // document can never be submitted for stamping.
  const validateRes = await page.request.post(
    BASE + `/api/invoices/${bill?.invoiceId}/validate`,
    { headers: CSRF },
  );
  const submitRes = await page.request.post(
    BASE + `/api/invoices/${bill?.invoiceId}/submit`,
    { headers: CSRF },
  );
  check(
    "orientation guard answers 409 for validate and submit of a bill",
    validateRes.status() === 409 && submitRes.status() === 409,
    `validate ${validateRes.status()}, submit ${submitRes.status()}`,
  );

  await signOutFromApp(page, BASE);
}

// ---------- VAT position, SME VAT page & the monthly compliance pack --------
// The contract-0.45.0 reporting surfaces: the per-client month-to-date VAT
// position (API shape + the SME page + the CSV export), the compliance-pack
// PDF, and — as the firm admin — the console rollup plus the consent-gated
// notify. The seed's issue dates are RELATIVE to the run date, so every check
// asserts shape and parseability, never totals. Sessions are API sign-ins
// (page.request shares the browser context's cookie jar, so page.goto rides
// the same session); the journey signs out at the end so the next journey's
// portal shows the demo buttons again.
async function journeyVatPositionAndPack(page, BASE, check) {
  await apiLogin(page, BASE, "demo.staff@meridianiq.example");

  // The month-to-date position for the demo client (current Lagos month by
  // default — the option list includes it, unlike the closed-month VAT pack).
  const posRes = await page.request.get(
    BASE + `/api/vat-position?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
  );
  const pos = posRes.status() === 200 ? await posRes.json() : null;
  check(
    "VAT position API answers the month-to-date shape",
    posRes.status() === 200 &&
      typeof pos?.outputVat === "string" &&
      Number.isFinite(Number(pos.outputVat)) &&
      Number(pos.outputVat) >= 0 &&
      Array.isArray(pos?.months) &&
      pos.months.length > 0,
    `status ${posRes.status()}`,
  );

  // The SME VAT page. Early in a Lagos month the seeded documents (issued
  // 4–10 days ago) can ALL fall in the previous month, so the current month
  // legitimately renders the honest empty state — in that case pick the
  // previous month from the card's own picker: INV-1003 (accepted attempt)
  // is always inside one of the two newest months, so the summary rows
  // render deterministically either way.
  await page.goto(BASE + "/app/vat", { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="card-vat-position"]', {
    timeout: 15000,
  });
  if (pos && (pos.outputInvoiceCount ?? 0) + (pos.billCount ?? 0) === 0) {
    await page.getByTestId("select-vat-month").selectOption(pos.months[1]);
  }
  await page.waitForSelector('[data-testid="text-vat-output"]', {
    timeout: 15000,
  });
  check("SME VAT page renders the position rows", true);

  const csvRes = await page.request.get(
    BASE + `/api/vat-position/export?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
  );
  check(
    "VAT position CSV export delivers the per-document file",
    csvRes.status() === 200 &&
      (csvRes.headers()["content-type"] ?? "").startsWith("text/csv"),
    `status ${csvRes.status()}`,
  );

  // The monthly compliance pack is one server-rendered PDF (cover note falls
  // back to the deterministic template when no model provider is configured
  // — never an error).
  const packRes = await page.request.get(
    BASE + `/api/compliance-pack?clientPartyId=${DEMO_CLIENT_PARTY_ID}`,
  );
  const packBody = packRes.status() === 200 ? await packRes.body() : null;
  check(
    "compliance pack renders a PDF",
    packRes.status() === 200 &&
      (packRes.headers()["content-type"] ?? "").startsWith("application/pdf") &&
      packBody?.subarray(0, 4).toString() === "%PDF",
    `status ${packRes.status()}`,
  );

  // Firm side as the admin: the rollup, then the consent-gated notify — 202
  // whether anything was sent (the endpoint is never a consent oracle).
  await apiLogin(page, BASE, "demo.admin@meridianiq.example");
  const firmRes = await page.request.get(BASE + "/api/console/vat-positions");
  const firm = firmRes.status() === 200 ? await firmRes.json() : null;
  check(
    "console VAT positions roll up rows across the engaged book",
    firmRes.status() === 200 &&
      Array.isArray(firm?.rows) &&
      firm.rows.length > 0,
    `status ${firmRes.status()}`,
  );
  const notifyRes = await page.request.post(
    BASE + "/api/compliance-pack/notify",
    { data: { clientPartyId: DEMO_CLIENT_PARTY_ID }, headers: CSRF },
  );
  check(
    "compliance-pack notify answers 202 (consent-gated fan-out)",
    notifyRes.status() === 202,
    `status ${notifyRes.status()}`,
  );

  await apiLogout(page, BASE);
}

export { journeyPayables, journeyVatPositionAndPack };
