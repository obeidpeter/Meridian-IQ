import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  firmsTable,
  usersTable,
} from "@workspace/db";
import clerkRouter from "./clerk/index.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import type { AskAnswer } from "../modules/clerk/ask.ts";
import { firmFastLaneThreshold } from "../modules/clerk/metrics.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../modules/clerk/test-support.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { clientPrincipal, crossTenantPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// Round 7 review integrity + Ask feedback. Pinned invariants:
//  - source pages are an operator-only carve-out (clerk.use) from the blanket
//  sourceScanPagesB64 strip, with an honest `purged` marker: true only when a
//  pdf case's content was retention-cleared in a terminal state;
//  - feedback is creator-only for EVERY role, question cases only, 404
//  non-disclosure on tenant/creator mismatch, re-rating overwrites, refusals
//  are ratable;
//  - the ask-feedback report mines ratings per platform-recorded intent
//  bucket (dataIntent | plan | register | refused) with an honest unrated
//  count;
//  - every listed/fetched case carries its firm's fast-lane threshold.

const SALT = makeRunSalt();

const firm1 = randomUUID();
const firm2 = randomUUID();

const operator: Principal = crossTenantPrincipal("operator");
const adminF1: Principal = firmPrincipal(firm1);
const adminF2: Principal = { ...adminF1, userId: randomUUID(), firmId: firm2 };
const clientA: Principal = clientPrincipal(firm1, randomUUID());
// Sibling client_user in the SAME firm, different party.
const clientB: Principal = {
  ...clientA,
  userId: randomUUID(),
  clientPartyId: randomUUID(),
};

const PAGE_1 = "cGFnZTE="; // "page1"
const PAGE_2 = "cGFnZTI="; // "page2"

let scanCaseId = "";
let textPdfCaseId = "";
let imageCaseId = "";
let questionCaseId = ""; // clientA's answered data question
let refusalCaseId = ""; // clientA's refusal
let extractionCaseId = ""; // clientA's extraction case (never ratable)
let registerCaseId = ""; // pre-rated register answer (helpful)
let unratedCaseId = ""; // answered, never rated

// An Ask 2.0 multi-part answer, shaped as ask.ts stores it: no flat
// dataIntent, a non-empty plan with one section per executed step. The
// stored jsonb type is the lean pre-0.56 ClerkAnswer, so this mirrors
// ask.ts's own write-site typing (AskAnswer assigns to the column type).
const planAnswer: AskAnswer = {
  answered: true,
  plan: [
    { key: "data.overdue_submissions", title: "Overdue submissions" },
    { key: "data.payables_due", title: "Bills due soon" },
  ],
  sections: [
    {
      title: "Overdue submissions",
      text: "No overdue submissions.",
      dataIntent: "data.overdue_submissions",
      facts: [],
    },
    {
      title: "Bills due soon",
      text: "No bills due.",
      dataIntent: "data.payables_due",
      facts: [],
    },
  ],
};

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  for (const p of [operator, adminF1, adminF2, clientA, clientB]) {
    await db
      .insert(usersTable)
      .values({ id: p.userId, email: `clerk-ri-${p.userId}@test.local` })
      .onConflictDoNothing();
  }
  await db.insert(firmsTable).values([
    { id: firm1, name: `Review Integrity Firm1 ${SALT}` },
    { id: firm2, name: `Review Integrity Firm2 ${SALT}` },
  ]);

  const rows = await db
    .insert(clerkCasesTable)
    .values([
      // A scanned-PDF capture holding its rendered pages (review material).
      {
        kind: "extraction",
        status: "extracted",
        sourceType: "pdf",
        sourceName: `scan-${SALT}.pdf`,
        sourceScanPagesB64: [PAGE_1, PAGE_2],
        firmId: firm1,
        createdBy: adminF1.userId,
      },
      // A text-layer PDF: has sourceText, never had pages.
      {
        kind: "extraction",
        status: "extracted",
        sourceType: "pdf",
        sourceName: `text-${SALT}.pdf`,
        sourceText: `Invoice TXT-${SALT} total 100`,
        firmId: firm1,
        createdBy: adminF1.userId,
      },
      // An image capture already retention-cleared: terminal, content null —
      // but NOT a pdf, so it must never claim "purged pages".
      {
        kind: "extraction",
        status: "approved",
        sourceType: "image",
        sourceName: `img-${SALT}.png`,
        firmId: firm1,
        createdBy: adminF1.userId,
      },
      // clientA's answered data question (feedback target).
      {
        kind: "question",
        status: "approved",
        question: `What is overdue? ${SALT}`,
        answer: { answered: true, dataIntent: "data.overdue_submissions" },
        firmId: firm1,
        createdBy: clientA.userId,
      },
      // clientA's refusal — refusals are ratable.
      {
        kind: "question",
        status: "escalated",
        question: `Something unanswerable ${SALT}`,
        answer: { answered: false, refusalReason: "refused (test)" },
        firmId: firm1,
        createdBy: clientA.userId,
      },
      // clientA's extraction case — never takes feedback.
      {
        kind: "extraction",
        status: "extracted",
        sourceType: "text",
        sourceText: `Invoice FB-${SALT} total 50`,
        firmId: firm1,
        createdBy: clientA.userId,
      },
      // A register (claim) answer, pre-rated helpful — byIntent 'register'.
      {
        kind: "question",
        status: "approved",
        question: `What is the VAT rate? ${SALT}`,
        answer: { answered: true, claimKey: "vat.standard_rate" },
        feedback: "helpful",
        firmId: firm1,
        createdBy: adminF1.userId,
      },
      // Answered but never rated — the report's unrated bucket.
      {
        kind: "question",
        status: "approved",
        question: `Unrated question ${SALT}`,
        answer: { answered: true, dataIntent: "data.failed_submissions" },
        firmId: firm1,
        createdBy: adminF1.userId,
      },
      // The multi-part (plan) answer: must bucket under 'plan' in the
      // feedback report, never miscount as 'refused'.
      {
        kind: "question",
        status: "approved",
        question: `What is overdue and what do we owe? ${SALT}`,
        answer: planAnswer,
        feedback: "not_helpful",
        firmId: firm1,
        createdBy: adminF1.userId,
      },
    ])
    .returning({ id: clerkCasesTable.id });
  [
    scanCaseId,
    textPdfCaseId,
    imageCaseId,
    questionCaseId,
    refusalCaseId,
    extractionCaseId,
    registerCaseId,
    unratedCaseId,
  ] = rows.map((r) => r.id);
});

after(async () => {
  await restoreClerkFlag();
  await closeAllServers();
});

// ---- Source pages (operator carve-out) --------------------------------------

test("an operator reads a scan case's rendered pages; a text-layer pdf has none", async () => {
  const base = await listen(appFor(operator, clerkRouter));

  const scan = await fetch(`${base}/clerk/cases/${scanCaseId}/source-pages`);
  assert.equal(scan.status, 200);
  assert.deepEqual(await scan.json(), {
    pages: [PAGE_1, PAGE_2],
    purged: false,
  });

  const textPdf = await fetch(
    `${base}/clerk/cases/${textPdfCaseId}/source-pages`,
  );
  assert.equal(textPdf.status, 200);
  assert.deepEqual(await textPdf.json(), { pages: [], purged: false });
});

test("firm principals are refused source pages per the clerk.use gate", async () => {
  // The review pane is operator-only: the capability gate answers 403 before
  // any row is read, for the firm that owns the case and a foreign firm alike.
  for (const principal of [adminF1, adminF2, clientA]) {
    const base = await listen(appFor(principal, clerkRouter));
    const res = await fetch(`${base}/clerk/cases/${scanCaseId}/source-pages`);
    assert.equal(res.status, 403);
  }
});

test("after retention clears a scan's content, the response is the honest purged shape", async () => {
  // Simulate the retention sweep: terminal status, all content columns null.
  await getDb()
    .update(clerkCasesTable)
    .set({ status: "approved", sourceScanPagesB64: null, sourceText: null })
    .where(eq(clerkCasesTable.id, scanCaseId));

  const base = await listen(appFor(operator, clerkRouter));
  const res = await fetch(`${base}/clerk/cases/${scanCaseId}/source-pages`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pages: [], purged: true });

  // A retention-cleared NON-pdf case never claims purged pages: there were
  // never pages to purge.
  const img = await fetch(`${base}/clerk/cases/${imageCaseId}/source-pages`);
  assert.equal(img.status, 200);
  assert.deepEqual(await img.json(), { pages: [], purged: false });

  const missing = await fetch(
    `${base}/clerk/cases/${randomUUID()}/source-pages`,
  );
  assert.equal(missing.status, 404);
});

// ---- Feedback (creator-only helpfulness signal) -----------------------------

const rate = async (base: string, caseId: string, helpful: boolean) =>
  fetch(`${base}/clerk/cases/${caseId}/feedback`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ helpful }),
  });

const storedFeedback = async (caseId: string): Promise<string | null> => {
  const [row] = await getDb()
    .select({ feedback: clerkCasesTable.feedback })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, caseId))
    .limit(1);
  return row?.feedback ?? null;
};

test("the creator rates a question case, re-rates to overwrite, and can rate a refusal", async () => {
  const base = await listen(appFor(clientA, clerkRouter));

  const first = await rate(base, questionCaseId, true);
  assert.equal(first.status, 204);
  assert.equal(await storedFeedback(questionCaseId), "helpful");

  // Re-rating overwrites — the asker changed their mind.
  const second = await rate(base, questionCaseId, false);
  assert.equal(second.status, 204);
  assert.equal(await storedFeedback(questionCaseId), "not_helpful");

  // Refusals are ratable: an unhelpful refusal is exactly the signal the
  // report mines. (Rated helpful here to exercise the refused/helpful cell.)
  const refusal = await rate(base, refusalCaseId, true);
  assert.equal(refusal.status, 204);
  assert.equal(await storedFeedback(refusalCaseId), "helpful");
});

test("only the creator may rate — every other principal gets the non-disclosure 404", async () => {
  // Same-firm staff, a same-firm sibling client, a foreign firm's admin and
  // even an operator: none of them asked the question, so none may rate it.
  for (const principal of [adminF1, clientB, adminF2, operator]) {
    const base = await listen(appFor(principal, clerkRouter));
    const res = await rate(base, questionCaseId, true);
    assert.equal(res.status, 404, `role ${principal.role} must see 404`);
  }
  // The rating is untouched.
  assert.equal(await storedFeedback(questionCaseId), "not_helpful");
});

test("an extraction case takes no feedback (409), even from its creator", async () => {
  const base = await listen(appFor(clientA, clerkRouter));
  const res = await rate(base, extractionCaseId, true);
  assert.equal(res.status, 409);
  assert.equal(await storedFeedback(extractionCaseId), null);
});

// ---- Ask-feedback report ----------------------------------------------------

test("the ask-feedback report mines totals, per-intent cells and the newest not-helpful questions", async () => {
  const base = await listen(appFor(operator, clerkRouter));
  const res = await fetch(`${base}/clerk/ask-feedback`);
  assert.equal(res.status, 200);
  const report = (await res.json()) as {
    totals: { helpful: number; notHelpful: number; unrated: number };
    byIntent: { intent: string; helpful: number; notHelpful: number }[];
    recentNotHelpful: { caseId: string; question: string; createdAt: string }[];
  };

  // Platform-wide report over a shared test DB: sibling suites also create
  // question cases, so totals are lower bounds and rows are matched by id.
  assert.ok(report.totals.helpful >= 2, "register + refusal ratings counted");
  assert.ok(report.totals.notHelpful >= 1);
  assert.ok(report.totals.unrated >= 1, "answered-but-unrated is counted");

  const cell = (intent: string) =>
    report.byIntent.find((r) => r.intent === intent);
  assert.ok(
    (cell("data.overdue_submissions")?.notHelpful ?? 0) >= 1,
    "the data answer's final rating lands under its recorded intent",
  );
  assert.ok(
    (cell("register")?.helpful ?? 0) >= 1,
    "claim answers group under 'register'",
  );
  assert.ok(
    (cell("refused")?.helpful ?? 0) >= 1,
    "refusals group under 'refused'",
  );
  assert.ok(
    (cell("plan")?.notHelpful ?? 0) >= 1,
    "multi-part (plan) answers group under 'plan', not 'refused'",
  );

  // Our re-rated case is among the newest not-helpful rows, with its
  // question text and a parseable timestamp.
  const mine = report.recentNotHelpful.find((r) => r.caseId === questionCaseId);
  assert.ok(mine, "the not-helpful case is listed");
  assert.equal(mine!.question, `What is overdue? ${SALT}`);
  assert.ok(Number.isFinite(Date.parse(mine!.createdAt)));
  // Helpful and unrated cases never appear in the not-helpful list.
  assert.ok(
    report.recentNotHelpful.every(
      (r) => r.caseId !== registerCaseId && r.caseId !== unratedCaseId,
    ),
  );
});

test("the ask-feedback report is operator-only", async () => {
  const base = await listen(appFor(adminF1, clerkRouter));
  const res = await fetch(`${base}/clerk/ask-feedback`);
  assert.equal(res.status, 403);
});

// ---- Fast-lane threshold attachment -----------------------------------------

test("listed and fetched cases expose the firm's fast-lane threshold", async () => {
  const expected = await firmFastLaneThreshold(firm1);
  const base = await listen(appFor(adminF1, clerkRouter));

  const list = (await (
    await fetch(`${base}/clerk/cases?kind=extraction`)
  ).json()) as Array<{ id: string; fastLaneThreshold?: number }>;
  const listed = list.find((c) => c.id === textPdfCaseId);
  assert.ok(listed, "the firm's case is listed");
  assert.equal(listed!.fastLaneThreshold, expected);
  for (const row of list) {
    assert.equal(typeof row.fastLaneThreshold, "number");
  }

  const detail = (await (
    await fetch(`${base}/clerk/cases/${textPdfCaseId}`)
  ).json()) as { fastLaneThreshold?: number };
  assert.equal(detail.fastLaneThreshold, expected);
});
