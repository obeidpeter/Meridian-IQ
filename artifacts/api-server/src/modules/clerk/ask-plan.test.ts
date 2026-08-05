import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  claimRecordsTable,
  clerkCasesTable,
  engagementsTable,
  firmsTable,
  partiesTable,
  invoicesTable,
  settlementEventsTable,
  submissionAttemptsTable,
  usersTable,
  type ClerkAnswer,
} from "@workspace/db";
import { askClerk, type AskAnswer } from "./ask.ts";
import {
  CLIENT_SAFE_DATA_INTENTS,
  DATA_INTENTS,
  lagosMonthOptions,
  runDataIntent,
  stripCurrentMonth,
} from "./data-intents/index.ts";
import { priorMonthStart } from "./data-intents/deltas.ts";
import type { CompletionRequest } from "./gateway.ts";
import { inClerkScope } from "./scope.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Ask 2.0 (contract 0.56.0): the ordered plan, per-step execution and the
// pins-by-id follow-up thread. The invariants pinned here:
//  - a SINGLE-step plan answers in the exact pre-plan flat shape (no
//    sections, no plan key) PLUS pins — every pre-0.56 consumer behaves
//    identically;
//  - a multi-step plan answers in sections with a FRESH parameter set per
//    step (the shared-params hazard fix), a deterministic lead-in, the
//    executed plan, and the LAST answered step's pins;
//  - a client asker's forced own-party pin applies PER STEP (SEC-03);
//  - claim keys never mix into a multi-step plan; duplicate steps dedupe;
//    an all-refused plan refuses whole with the first reason;
//  - follow-ups re-pin BY ID (two clients sharing a legal name resolve to
//    the exact previous party — the label-matching hazard fix), stale pins
//    drop silently, and pre-0.56 cases still thread via label matching;
//  - the delta intents compute signed month-over-month numbers from the
//    predecessor-month window, month_delta is client-safe, client_breakdown
//    is firm-only, and both sit LAST in the model-facing catalogue order;
//  - through all of it: ONE model call per ask.

const SALT = makeRunSalt();

const firmP = randomUUID();
const alphaParty = randomUUID(); // "PL Alpha A ..." — sorts first => c1
const samePartyOne = randomUUID(); // the same-legal-name pair (the hazard)
const samePartyTwo = randomUUID();
const zuluParty = randomUUID(); // "PL Zulu Z ..." — sorts last
const vendorParty = randomUUID(); // bills supplier, NOT engaged
const staffId = randomUUID();
const clientAskerId = randomUUID(); // client_user pinned to zuluParty

const ALPHA_NAME = `PL Alpha A ${SALT}`;
const SAME_NAME = `PL Same Name ${SALT}`;
const ZULU_NAME = `PL Zulu Z ${SALT}`;

const MONTHS = lagosMonthOptions();

const ALPHA_CUR_NUM = `PLA-CUR-${SALT}`; // accepted in MONTHS[0], 800.00
const ALPHA_PRV_NUM = `PLA-PRV-${SALT}`; // accepted in MONTHS[1], 300.00
const ZULU_CUR_NUM = `PLZ-CUR-${SALT}`; // accepted in MONTHS[0], 100.00
const ZULU_PRV_NUM = `PLZ-PRV-${SALT}`; // accepted in MONTHS[1], 400.00
const ALPHA_OVD_NUM = `PLA-OVD-${SALT}`; // overdue draft (alpha)
const ZULU_OVD_NUM = `PLZ-OVD-${SALT}`; // overdue draft (zulu)
const BILL_CUR_NUM = `PLB-CUR-${SALT}`; // unpaid bill due in MONTHS[0], 200.00
const BILL_PRV_NUM = `PLB-PRV-${SALT}`; // unpaid bill due in MONTHS[1], 500.00
const BILL_PAID_NUM = `PLB-PAID-${SALT}`; // paid bill due in MONTHS[0] — excluded

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmP, name: `Plan Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: alphaParty, type: "client_business", legalName: ALPHA_NAME },
    { id: samePartyOne, type: "client_business", legalName: SAME_NAME },
    { id: samePartyTwo, type: "client_business", legalName: SAME_NAME },
    { id: zuluParty, type: "client_business", legalName: ZULU_NAME },
    { id: vendorParty, type: "buyer", legalName: `PL Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values(
    [alphaParty, samePartyOne, samePartyTwo, zuluParty].map(
      (clientPartyId) => ({
        firmId: firmP,
        clientPartyId,
        type: "readiness_assessment" as const,
        title: `Plan engagement ${SALT}`,
      }),
    ),
  );
  await db
    .insert(usersTable)
    .values([
      { id: staffId, email: `plan-staff-${SALT}@test.example` },
      { id: clientAskerId, email: `plan-client-${SALT}@test.example` },
    ])
    .onConflictDoNothing();

  type InvoiceSeed = typeof invoicesTable.$inferInsert;
  const invoice = (
    over: Partial<InvoiceSeed> &
      Pick<InvoiceSeed, "invoiceNumber" | "issueDate" | "supplierPartyId">,
  ): InvoiceSeed => ({
    firmId: firmP,
    buyerPartyId: over.supplierPartyId,
    ...over,
  });
  const alphaCurId = randomUUID();
  const alphaPrvId = randomUUID();
  const zuluCurId = randomUUID();
  const zuluPrvId = randomUUID();
  const billPaidId = randomUUID();
  await db.insert(invoicesTable).values([
    // Rails-accepted paper, two Lagos months, two clients — the delta and
    // breakdown fixtures. Anchored to the SAME month list the assertions use
    // (mid-month dates), the data-intents.test.ts discipline.
    invoice({
      id: alphaCurId,
      invoiceNumber: ALPHA_CUR_NUM,
      supplierPartyId: alphaParty,
      status: "submitted",
      issueDate: `${MONTHS[0].key}-05`,
      grandTotal: "800.00",
      vatTotal: "150.00",
    }),
    invoice({
      id: alphaPrvId,
      invoiceNumber: ALPHA_PRV_NUM,
      supplierPartyId: alphaParty,
      status: "submitted",
      issueDate: `${MONTHS[1].key}-05`,
      grandTotal: "300.00",
      vatTotal: "100.00",
    }),
    invoice({
      id: zuluCurId,
      invoiceNumber: ZULU_CUR_NUM,
      supplierPartyId: zuluParty,
      status: "submitted",
      issueDate: `${MONTHS[0].key}-06`,
      grandTotal: "100.00",
      vatTotal: "0.00",
    }),
    invoice({
      id: zuluPrvId,
      invoiceNumber: ZULU_PRV_NUM,
      supplierPartyId: zuluParty,
      status: "submitted",
      issueDate: `${MONTHS[1].key}-06`,
      grandTotal: "400.00",
      vatTotal: "0.00",
    }),
    // Overdue drafts for the plan-execution and forced-pin assertions.
    invoice({
      invoiceNumber: ALPHA_OVD_NUM,
      supplierPartyId: alphaParty,
      status: "draft",
      issueDate: lagosDateOffset(-30),
    }),
    invoice({
      invoiceNumber: ZULU_OVD_NUM,
      supplierPartyId: zuluParty,
      status: "draft",
      issueDate: lagosDateOffset(-30),
    }),
    // Captured vendor bills (buyer = alpha): due in each month, plus a paid
    // one that must never count. vat 0 keeps the VAT deltas output-only.
    {
      firmId: firmP,
      supplierPartyId: vendorParty,
      buyerPartyId: alphaParty,
      invoiceNumber: BILL_CUR_NUM,
      status: "draft",
      issueDate: `${MONTHS[0].key}-04`,
      dueDate: `${MONTHS[0].key}-10`,
      grandTotal: "200.00",
      vatTotal: "0.00",
    },
    {
      firmId: firmP,
      supplierPartyId: vendorParty,
      buyerPartyId: alphaParty,
      invoiceNumber: BILL_PRV_NUM,
      status: "draft",
      issueDate: `${MONTHS[1].key}-04`,
      dueDate: `${MONTHS[1].key}-10`,
      grandTotal: "500.00",
      vatTotal: "0.00",
    },
    {
      id: billPaidId,
      firmId: firmP,
      supplierPartyId: vendorParty,
      buyerPartyId: alphaParty,
      invoiceNumber: BILL_PAID_NUM,
      status: "draft",
      issueDate: `${MONTHS[0].key}-04`,
      dueDate: `${MONTHS[0].key}-12`,
      grandTotal: "999.00",
      vatTotal: "0.00",
    },
  ]);
  await db.insert(settlementEventsTable).values({
    invoiceId: billPaidId,
    source: "payer_flag",
    amount: "999.00",
    paymentStatus: "paid",
    actorId: staffId,
    occurredAt: new Date(),
  });
  await db.insert(submissionAttemptsTable).values(
    [
      { invoiceId: alphaCurId, month: MONTHS[0].key, tag: "ac" },
      { invoiceId: alphaPrvId, month: MONTHS[1].key, tag: "ap" },
      { invoiceId: zuluCurId, month: MONTHS[0].key, tag: "zc" },
      { invoiceId: zuluPrvId, month: MONTHS[1].key, tag: "zp" },
    ].map((a) => ({
      invoiceId: a.invoiceId,
      rail: "rail_primary" as const,
      attemptNo: 1,
      idempotencyKey: `plan-${a.tag}-${SALT}`,
      status: "accepted" as const,
      createdAt: new Date(`${a.month}-15T12:00:00Z`),
    })),
  );
});

after(async () => {
  await restoreClerkFlag();
});

const answerOf = (kase: { answer: ClerkAnswer | null }): AskAnswer => {
  assert.ok(kase.answer);
  return kase.answer as AskAnswer;
};

// ---- Catalogue posture ------------------------------------------------------

test("the catalogue tail keeps its append-only order (deltas, then obligations)", () => {
  // The model-facing list is APPEND-ONLY: groups keep the position they
  // joined at. The deltas were appended by Ask 2.0, the obligations group by
  // Notice Desk — a reorder here means the append-only rule was broken.
  const keys = DATA_INTENTS.map((i) => i.key);
  assert.deepEqual(keys.slice(-3), [
    "data.month_delta",
    "data.client_breakdown",
    "data.open_obligations",
  ]);
});

test("month_delta is client-safe (and accepts the forced pin); client_breakdown is firm-only", () => {
  const monthDelta = CLIENT_SAFE_DATA_INTENTS.find(
    (i) => i.key === "data.month_delta",
  );
  assert.ok(monthDelta, "month_delta is offered to client askers");
  assert.equal(monthDelta.accepts.client, true);
  assert.ok(
    !CLIENT_SAFE_DATA_INTENTS.some((i) => i.key === "data.client_breakdown"),
    "client_breakdown ranks the firm's clients and must never be offered to a client",
  );
  const breakdown = DATA_INTENTS.find((i) => i.key === "data.client_breakdown");
  assert.deepEqual(breakdown?.accepts, { month: true });
});

test("priorMonthStart carries January back into the prior year", () => {
  assert.equal(priorMonthStart("2026-01-01"), "2025-12-01");
  assert.equal(priorMonthStart("2026-07-01"), "2026-06-01");
});

// ---- Delta lookups ----------------------------------------------------------

test("month_delta compares the pinned month with its predecessor, signs included", async () => {
  const result = await inClerkScope(firmP, () =>
    runDataIntent("data.month_delta", firmP),
  );
  assert.ok(result);
  const fact = (key: string) => result.facts.find((f) => f.key === key)?.value;
  // Six underlying numbers + three signed deltas.
  assert.equal(fact("submitted_total"), "900.00");
  assert.equal(fact("submitted_total_prior"), "700.00");
  assert.equal(fact("submitted_delta"), "+200.00");
  assert.equal(fact("net_vat"), "150.00");
  assert.equal(fact("net_vat_prior"), "100.00");
  assert.equal(fact("net_vat_delta"), "+50.00");
  assert.equal(fact("payables_due"), "200.00");
  assert.equal(fact("payables_due_prior"), "500.00");
  assert.equal(fact("payables_due_delta"), "-300.00");
  assert.equal(result.facts.length, 9);
  assert.ok(result.text.includes("+200.00"), "growth phrased with its sign");
  assert.ok(result.text.includes("-300.00"), "a drop phrased with its sign");
  assert.ok(result.text.includes(stripCurrentMonth(MONTHS[0].label)));
  assert.ok(result.text.includes(stripCurrentMonth(MONTHS[1].label)));
  assert.equal(result.links, undefined, "delta answers are linkless");

  // A pinned month compares against ITS predecessor (the window proof):
  // MONTHS[1] vs MONTHS[2], where nothing was accepted.
  const pinned = await inClerkScope(firmP, () =>
    runDataIntent("data.month_delta", firmP, {
      monthStart: MONTHS[1].monthStart,
      monthLabel: MONTHS[1].label,
    }),
  );
  assert.equal(
    pinned?.facts.find((f) => f.key === "submitted_total")?.value,
    "700.00",
  );
  assert.equal(
    pinned?.facts.find((f) => f.key === "submitted_total_prior")?.value,
    "0",
  );
  assert.equal(
    pinned?.facts.find((f) => f.key === "submitted_delta")?.value,
    "+700.00",
  );

  // The client pin narrows every side to that client's own paper.
  const forAlpha = await inClerkScope(firmP, () =>
    runDataIntent("data.month_delta", firmP, {
      clientPartyId: alphaParty,
      clientName: ALPHA_NAME,
    }),
  );
  assert.ok(forAlpha?.text.includes(`for ${ALPHA_NAME}`));
  assert.equal(
    forAlpha?.facts.find((f) => f.key === "submitted_delta")?.value,
    "+500.00",
    "alpha alone moved 300.00 -> 800.00",
  );
  assert.equal(
    forAlpha?.facts.find((f) => f.key === "net_vat_delta")?.value,
    "+50.00",
  );
});

test("client_breakdown ranks movers up and down by signed NGN delta", async () => {
  const result = await inClerkScope(firmP, () =>
    runDataIntent("data.client_breakdown", firmP),
  );
  assert.ok(result);
  assert.equal(
    result.facts.find((f) => f.key === "movers_up")?.value,
    "1",
  );
  assert.equal(
    result.facts.find((f) => f.key === "movers_down")?.value,
    "1",
  );
  const up1 = result.facts.find((f) => f.key === "up_1");
  assert.equal(up1?.label, ALPHA_NAME);
  assert.equal(up1?.value, "+500.00");
  const down1 = result.facts.find((f) => f.key === "down_1");
  assert.equal(down1?.label, ZULU_NAME);
  assert.equal(down1?.value, "-300.00");
  assert.ok(result.text.includes(`${ALPHA_NAME} (+500.00 NGN)`));
  assert.ok(result.text.includes(`${ZULU_NAME} (-300.00 NGN)`));
  assert.equal(result.links, undefined, "the ranking is linkless");

  // Defensive: a client pin cannot reach this intent through ask.ts
  // (accepts.client is false and the forced pin refuses first), but the
  // lookup itself must never rank firm-wide for a pinned caller.
  const pinned = await inClerkScope(firmP, () =>
    runDataIntent("data.client_breakdown", firmP, {
      clientPartyId: zuluParty,
      clientName: ZULU_NAME,
    }),
  );
  assert.ok(pinned?.text.includes("cannot be filtered to one client"));
  assert.deepEqual(pinned?.facts, []);
});

// ---- Plan execution through askClerk ---------------------------------------

test("a single-step plan answers in the exact flat shape, plus pins", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
      ],
    });
  });
  const kase = await askClerk(`What is overdue? ${SALT}`, staffId, gateway, {
    firmId: firmP,
  });
  assert.equal(calls.length, 1, "ONE model call per ask");
  assert.equal(kase.status, "approved");
  const answer = answerOf(kase);
  // The pre-plan flat shape exactly — no sections, no plan — plus pins.
  assert.deepEqual(Object.keys(answer).sort(), [
    "answered",
    "citation",
    "dataIntent",
    "facts",
    "links",
    "pins",
    "proposition",
  ]);
  assert.equal(answer.dataIntent, "data.overdue_submissions");
  assert.ok(answer.proposition?.includes(ALPHA_OVD_NUM));
  assert.ok(answer.proposition?.includes(ZULU_OVD_NUM));
  assert.deepEqual(answer.pins, {}, "an unscoped answer pins nothing — but pins present marks the case follow-up-ready by id");
});

test("a scoped single step records ids AND labels in pins", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        {
          key: "data.submitted_this_month",
          month: MONTHS[0].key,
          client: "c1", // alpha — sorts first
        },
      ],
    }),
  );
  const kase = await askClerk(
    `What did ${ALPHA_NAME} get accepted this month? ${SALT}`,
    staffId,
    gateway,
    { firmId: firmP },
  );
  const answer = answerOf(kase);
  assert.equal(answer.sections, undefined);
  assert.equal(answer.plan, undefined);
  assert.deepEqual(answer.dataParams, {
    month: stripCurrentMonth(MONTHS[0].label),
    client: ALPHA_NAME,
  });
  assert.deepEqual(answer.pins, {
    monthStart: MONTHS[0].monthStart,
    monthLabel: stripCurrentMonth(MONTHS[0].label),
    clientPartyId: alphaParty,
    clientName: ALPHA_NAME,
  });
  assert.ok(answer.proposition?.includes(ALPHA_CUR_NUM));
  assert.ok(!answer.proposition?.includes(ALPHA_PRV_NUM));
  assert.ok(!answer.proposition?.includes(ZULU_CUR_NUM));
});

test("a two-step plan answers in sections with a FRESH parameter set per step", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.submitted_this_month", month: MONTHS[0].key, client: "none" },
        { key: "data.submitted_this_month", month: MONTHS[1].key, client: "none" },
      ],
    });
  });
  const kase = await askClerk(
    `Accepted this month and last month? ${SALT}`,
    staffId,
    gateway,
    { firmId: firmP },
  );
  assert.equal(calls.length, 1, "a plan still costs ONE model call");
  assert.equal(kase.status, "approved");
  const answer = answerOf(kase);
  assert.equal(answer.answered, true);
  // Flat lead-in names the part count; parts live in sections only.
  assert.equal(
    answer.proposition,
    "This question has 2 parts — each is answered separately below.",
  );
  assert.deepEqual(answer.facts, []);
  assert.equal(answer.links, undefined);
  assert.ok(answer.citation?.startsWith("Computed live from your firm's records on "));
  assert.deepEqual(
    answer.plan?.map((p) => p.key),
    ["data.submitted_this_month", "data.submitted_this_month"],
  );
  assert.ok(answer.plan?.every((p) => p.title.length > 0));
  assert.equal(answer.sections?.length, 2);
  const [s0, s1] = answer.sections!;
  // Step isolation (the shared-params hazard fix): each section's month is
  // its OWN — the first month never leaks into the second lookup.
  assert.equal(s0.dataParams?.month, stripCurrentMonth(MONTHS[0].label));
  assert.equal(s1.dataParams?.month, stripCurrentMonth(MONTHS[1].label));
  assert.ok(s0.text.includes(ALPHA_CUR_NUM));
  assert.ok(s0.text.includes(ZULU_CUR_NUM));
  assert.ok(!s0.text.includes(ALPHA_PRV_NUM));
  assert.ok(s1.text.includes(ALPHA_PRV_NUM));
  assert.ok(s1.text.includes(ZULU_PRV_NUM));
  assert.ok(!s1.text.includes(ALPHA_CUR_NUM));
  assert.equal(s0.dataIntent, "data.submitted_this_month");
  // Pins carry the LAST answered step's scope (the documented choice).
  assert.deepEqual(answer.pins, {
    monthStart: MONTHS[1].monthStart,
    monthLabel: stripCurrentMonth(MONTHS[1].label),
  });
});

test("a client asker's forced own-party pin applies to EVERY step (SEC-03)", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
        { key: "data.payables_due", month: "none", client: "none" },
      ],
    }),
  );
  const kase = await askClerk(
    `What is overdue, and what do we owe? ${SALT}`,
    clientAskerId,
    gateway,
    { firmId: firmP, clientScoped: true, clientPartyId: zuluParty },
  );
  assert.equal(kase.status, "approved");
  const answer = answerOf(kase);
  assert.equal(answer.sections?.length, 2);
  const [overdue, payables] = answer.sections!;
  assert.ok(overdue.text.includes(ZULU_OVD_NUM), "own overdue paper answers");
  assert.ok(
    !overdue.text.includes(ALPHA_OVD_NUM),
    "a sibling client's paper never appears in any section (SEC-03)",
  );
  assert.equal(overdue.dataParams?.client, ZULU_NAME);
  assert.ok(
    payables.text.includes(`for ${ZULU_NAME}`),
    "the second step is pinned too — zulu owes no bills",
  );
  assert.equal(answer.pins?.clientPartyId, zuluParty);

  // Dedup runs on the EFFECTIVE scope: for a client asker the client pick is
  // irrelevant (every step is forced to its own party), so these two steps
  // are ONE lookup — and a deduped single step answers flat, not sectioned.
  const dedupGateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
        { key: "data.overdue_submissions", month: "none", client: "c1" },
      ],
    }),
  );
  const deduped = await askClerk(
    `Overdue, twice? ${SALT}`,
    clientAskerId,
    dedupGateway,
    { firmId: firmP, clientScoped: true, clientPartyId: zuluParty },
  );
  assert.equal(deduped.status, "approved");
  const dedupedAnswer = answerOf(deduped);
  assert.equal(dedupedAnswer.sections, undefined);
  assert.equal(dedupedAnswer.dataIntent, "data.overdue_submissions");
});

test("duplicate steps dedupe app-side; a deduped single step answers flat", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
        { key: "data.overdue_submissions", month: "none", client: "none" },
      ],
    }),
  );
  const kase = await askClerk(`Overdue overdue? ${SALT}`, staffId, gateway, {
    firmId: firmP,
  });
  assert.equal(kase.status, "approved");
  const answer = answerOf(kase);
  assert.equal(answer.sections, undefined, "duplicates collapse to one step");
  assert.equal(answer.plan, undefined);
  assert.equal(answer.dataIntent, "data.overdue_submissions");
});

test("a claim mixed into a multi-step plan refuses whole", async () => {
  const claimKey = `test.plan_claim_${SALT}`;
  await getDb().insert(claimRecordsTable).values({
    claimKey,
    version: 1,
    state: "active",
    title: `Plan-mix claim ${SALT}`,
    proposition: "The standard VAT rate is {rate}.",
    protectedFacts: [
      { key: "rate", label: "Standard rate", kind: "rate", value: "7.5", unit: "%" },
    ],
    citation: "Test Act s.1",
    effectiveFrom: "2020-01-01",
    createdBy: staffId,
  });
  const gateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: claimKey, month: "none", client: "none" },
        { key: "data.overdue_submissions", month: "none", client: "none" },
      ],
    }),
  );
  const kase = await askClerk(
    `VAT rate and overdue? ${SALT}`,
    staffId,
    gateway,
    { firmId: firmP },
  );
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
  assert.ok(
    kase.answer?.refusalReason?.includes(
      "A register claim answers one question at a time",
    ),
  );

  // The same claim as a SINGLE step still answers verbatim from the register.
  const soloGateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [{ key: claimKey, month: "none", client: "none" }],
    }),
  );
  const solo = await askClerk(`Just the rate? ${SALT}`, staffId, soloGateway, {
    firmId: firmP,
  });
  assert.equal(solo.status, "approved");
  assert.equal(solo.answer?.claimKey, claimKey);
  assert.equal(
    (solo.answer as AskAnswer).pins,
    undefined,
    "claim answers carry no pins",
  );
});

test("a refused step becomes an honest section; ALL refused steps refuse whole", async () => {
  // Partial: step 2's month pin is unsupported — its section says so
  // WITHOUT claiming an escalation that did not happen.
  const partialGateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
        { key: "data.overdue_submissions", month: MONTHS[1].key, client: "none" },
      ],
    }),
  );
  const partial = await askClerk(
    `Overdue now and in a past month? ${SALT}`,
    staffId,
    partialGateway,
    { firmId: firmP },
  );
  assert.equal(partial.status, "approved");
  const answer = answerOf(partial);
  assert.equal(answer.answered, true);
  assert.equal(answer.sections?.length, 2);
  assert.ok(answer.sections![0].text.includes(ZULU_OVD_NUM));
  assert.equal(
    answer.sections![1].text,
    "This part could not be answered. That lookup always answers as of today and cannot be filtered to a month. Ask about rail submissions for month-by-month figures.",
  );
  assert.deepEqual(answer.sections![1].facts, []);
  assert.ok(
    !answer.sections![1].text.includes("escalated"),
    "an approved answer's section never claims an escalation",
  );
  assert.deepEqual(answer.pins, {}, "pins come from the LAST ANSWERED step");
  assert.equal(answer.plan?.length, 2, "the plan records both attempted steps");

  // All refused: the whole case refuses with the FIRST reason.
  const allRefusedGateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: MONTHS[1].key, client: "none" },
        { key: "data.clerk_allowance", month: "none", client: "c1" },
      ],
    }),
  );
  const refused = await askClerk(
    `Past overdue and allowance for a client? ${SALT}`,
    staffId,
    allRefusedGateway,
    { firmId: firmP },
  );
  assert.equal(refused.status, "escalated");
  assert.equal(refused.answer?.answered, false);
  assert.ok(
    refused.answer?.refusalReason?.includes(
      "That lookup always answers as of today",
    ),
    "the FIRST step's reason speaks for the whole refusal",
  );
  assert.equal((refused.answer as AskAnswer).sections, undefined);
});

test("more than three steps never validates — the case escalates", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
        { key: "data.payables_due", month: "none", client: "none" },
        { key: "data.total_owed", month: "none", client: "none" },
        { key: "data.failed_submissions", month: "none", client: "none" },
      ],
    }),
  );
  const kase = await askClerk(`Everything at once? ${SALT}`, staffId, gateway, {
    firmId: firmP,
  });
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
});

// ---- Follow-up pins (the label-matching hazard fix) -------------------------

// Insert a previous question case directly, exactly as askClerk stores it.
async function insertPreviousCase(answer: AskAnswer): Promise<string> {
  const [row] = await getDb()
    .insert(clerkCasesTable)
    .values({
      kind: "question",
      status: "approved",
      question: `seed previous ${SALT}`,
      firmId: firmP,
      createdBy: staffId,
      answer,
    })
    .returning({ id: clerkCasesTable.id });
  return row.id;
}

test("follow-ups re-pin BY ID: two clients sharing a legal name resolve to the exact previous party", async () => {
  // The hazard: label matching resolved whichever same-name client sorted
  // first. With pins, EACH of the two same-name parties round-trips to
  // itself. The scripted model echoes whatever client key the context line
  // offers — the app must map it back to the pinned party id.
  for (const party of [samePartyOne, samePartyTwo]) {
    const caseId = await insertPreviousCase({
      answered: true,
      dataIntent: "data.overdue_submissions",
      dataParams: { client: SAME_NAME },
      proposition: "seed",
      facts: [],
      citation: "seed",
      pins: { clientPartyId: party, clientName: SAME_NAME },
    });
    const prompts: string[] = [];
    const gateway = fakeGateway((req) => {
      prompts.push(req.user as string);
      const contextClient = /, client (c\d+)\./.exec(req.user as string);
      assert.ok(contextClient, "the context line offers the pinned client key");
      return JSON.stringify({
        category: "unknown",
        steps: [
          {
            key: "data.overdue_submissions",
            month: "none",
            client: contextClient[1],
          },
        ],
      });
    });
    const followUp = await askClerk(
      `And what is overdue for them? ${SALT}`,
      staffId,
      gateway,
      { firmId: firmP, previousCaseId: caseId },
    );
    assert.ok(prompts[0].includes("Previous question context"));
    assert.ok(
      !prompts[0].includes(party),
      "raw party ids never reach the prompt — only opaque c-keys",
    );
    assert.equal(followUp.status, "approved");
    assert.equal(
      answerOf(followUp).pins?.clientPartyId,
      party,
      "the follow-up scope is the SAME party id the previous answer used",
    );
  }
});

test("a stale pin is dropped silently — the option list moved on", async () => {
  const caseId = await insertPreviousCase({
    answered: true,
    dataIntent: "data.overdue_submissions",
    dataParams: { month: "March 2019", client: "Long Gone Ltd" },
    proposition: "seed",
    facts: [],
    citation: "seed",
    // Neither the month nor the party is on today's offered lists.
    pins: {
      monthStart: "2019-03-01",
      monthLabel: "March 2019",
      clientPartyId: randomUUID(),
      clientName: "Long Gone Ltd",
    },
  });
  const prompts: string[] = [];
  const gateway = fakeGateway((req) => {
    prompts.push(req.user as string);
    return JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.overdue_submissions", month: "none", client: "none" },
      ],
    });
  });
  await askClerk(`And now? ${SALT}`, staffId, gateway, {
    firmId: firmP,
    previousCaseId: caseId,
  });
  const contextLine = prompts[0]
    .split("\n")
    .find((l) => l.startsWith("Previous question context"));
  assert.ok(contextLine, "the intent itself still threads");
  assert.ok(
    contextLine.includes("data key data.overdue_submissions."),
    `stale month AND client pins contribute nothing (line: ${contextLine})`,
  );
  assert.ok(!contextLine.includes(", month "));
  assert.ok(!contextLine.includes(", client "));
});

test("a pre-0.56 case (no pins) still threads via label matching", async () => {
  const caseId = await insertPreviousCase({
    answered: true,
    dataIntent: "data.overdue_submissions",
    dataParams: { client: ALPHA_NAME },
    proposition: "seed",
    facts: [],
    citation: "seed",
    // No pins key at all — the legacy stored shape.
  });
  const prompts: string[] = [];
  const gateway = fakeGateway((req) => {
    prompts.push(req.user as string);
    return JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.unsubmitted_invoices", month: "none", client: "c1" },
      ],
    });
  });
  await askClerk(`And unsubmitted? ${SALT}`, staffId, gateway, {
    firmId: firmP,
    previousCaseId: caseId,
  });
  assert.ok(
    prompts[0].includes("client c1"),
    "the legal-name label maps back to the alpha option key",
  );
});

test("a multi-part previous answer threads its LAST plan step with its pins", async () => {
  const caseId = await insertPreviousCase({
    answered: true,
    proposition: "This question has 2 parts — each is answered separately below.",
    facts: [],
    citation: "seed",
    plan: [
      { key: "data.overdue_submissions", title: "overdue" },
      { key: "data.submitted_this_month", title: "accepted in month" },
    ],
    pins: {
      monthStart: MONTHS[1].monthStart,
      monthLabel: stripCurrentMonth(MONTHS[1].label),
    },
    sections: [],
  });
  const prompts: string[] = [];
  const gateway = fakeGateway((req) => {
    prompts.push(req.user as string);
    return JSON.stringify({
      category: "unknown",
      steps: [
        { key: "data.submitted_this_month", month: MONTHS[1].key, client: "c1" },
      ],
    });
  });
  await askClerk(`And for someone else? ${SALT}`, staffId, gateway, {
    firmId: firmP,
    previousCaseId: caseId,
  });
  assert.ok(
    prompts[0].includes(
      `used data key data.submitted_this_month, month ${MONTHS[1].key}.`,
    ),
    `the LAST executed step threads, scope by id (prompt: ${prompts[0].slice(0, 400)})`,
  );
});
