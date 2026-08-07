import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clerkAdvisoryBriefsTable,
  engagementsTable,
  filingReturnsTable,
  firmsTable,
  obligationsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import {
  buildBriefTemplate,
  buildBriefUser,
  computeAdvisoryBriefSections,
  generateAdvisoryBrief,
  listAdvisoryBriefs,
  type AdvisoryBriefSection,
} from "./advisory-brief.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Advise with Clerk Phase 1: the advisory brief. Pinned invariants:
//  - the sections are COMPOSED from the platform's own compute functions —
//    the statutory numbers here equal the filings/obligations registers'
//    numbers for the same seed, by construction;
//  - the template path always succeeds (gateway null stores a template
//    brief), and the phrased path only wins when grounded;
//  - one brief per (firm, client, live month): regeneration refreshes the
//    SAME row (id stable, updatedAt bumped);
//  - an un-engaged party id can never mint a row (404);
//  - every generate leaves an audit row.

const SALT = makeRunSalt();

const firmId = randomUUID();
const clientId = randomUUID();
const strangerId = randomUUID(); // a party with NO engagement to this firm
const userId = randomUUID();

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `brief-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Brief Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: clientId,
      type: "client_business" as const,
      legalName: `Brief Client ${SALT}`,
    },
    {
      id: strangerId,
      type: "client_business" as const,
      legalName: `Brief Stranger ${SALT}`,
    },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientId,
    type: "retainer" as const,
    status: "open" as const,
    title: `brief engagement ${SALT}`,
  });
  // Statutory seed: one overdue return, one due-soon return, one overdue
  // authority notice — the numbers the statutory section must restate.
  await db.insert(filingReturnsTable).values([
    {
      firmId,
      clientPartyId: clientId,
      taxType: "vat",
      period: "2026-06",
      dueDate: lagosDateOffset(-5),
      status: "upcoming" as const,
    },
    {
      firmId,
      clientPartyId: clientId,
      taxType: "paye",
      period: "2026-07",
      dueDate: lagosDateOffset(3),
      status: "upcoming" as const,
    },
  ]);
  await db.insert(obligationsTable).values({
    firmId,
    clientPartyId: clientId,
    noticeType: "assessment",
    authority: "firs",
    responseDueDate: lagosDateOffset(-2),
    status: "open" as const,
    createdBy: userId,
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("sections compose the platform's own numbers, evidence-cited", async () => {
  const sections = await computeAdvisoryBriefSections(firmId, clientId);
  assert.deepEqual(
    sections.map((s) => s.key),
    ["statutory", "penalties", "vat", "money", "hygiene"],
    "the closed section catalogue, in order",
  );
  for (const s of sections) {
    assert.ok(s.title.length > 0);
    assert.ok(s.text.length > 0);
    assert.ok(s.sourceReport.length > 0, `${s.key} cites its source report`);
  }
  const statutory = sections[0];
  const factValue = (key: string) =>
    statutory.facts.find((f) => f.key === key)?.value;
  assert.equal(factValue("unfiled"), "2", "both returns are unfiled");
  assert.equal(factValue("filings_overdue"), "1");
  assert.equal(factValue("filings_due_soon"), "1");
  assert.equal(factValue("obligations_open"), "1");
  assert.equal(factValue("obligations_overdue"), "1");
  const vat = sections[2];
  const vatDue = vat.facts.find((f) => f.key === "vat_due");
  assert.ok(vatDue && /^\d{4}-\d{2}-\d{2}$/.test(vatDue.value));
  assert.ok(
    sections[1].facts.some((f) => f.key === "overdue_invoices"),
    "penalty section always states the overdue count",
  );
});

test("template headline triage: overdue beats due-soon beats clear", () => {
  const mk = (
    overdue: number,
    dueSoon: number,
  ): AdvisoryBriefSection[] => [
    {
      key: "statutory",
      title: "Statutory position",
      text: "t.",
      facts: [
        { key: "filings_overdue", label: "x", kind: "count", value: String(overdue) },
        { key: "filings_due_soon", label: "x", kind: "count", value: String(dueSoon) },
        { key: "obligations_overdue", label: "x", kind: "count", value: "0" },
      ],
      sourceReport: "s",
    },
  ];
  assert.ok(buildBriefTemplate(mk(2, 0)).headline.includes("start there"));
  assert.ok(buildBriefTemplate(mk(0, 1)).headline.includes("next 7 days"));
  assert.ok(buildBriefTemplate(mk(0, 0)).headline.includes("on track"));
});

test("buildBriefUser restates every fact line (the grounding source)", async () => {
  const sections = await computeAdvisoryBriefSections(firmId, clientId);
  const user = buildBriefUser(sections);
  assert.ok(user.includes("Returns overdue: 1"));
  assert.ok(user.includes("Open authority notices: 1"));
  for (const s of sections) {
    assert.ok(user.includes(`${s.title}:`));
  }
});

test("gateway null: the template brief stores, audited, and regeneration refreshes the same row", async () => {
  const first = await generateAdvisoryBrief(firmId, clientId, null, userId);
  assert.equal(first.source, "template");
  assert.equal(first.generatedBy, userId);
  assert.equal((first.sections as unknown[]).length, 5);
  assert.ok(first.headline.includes("start there"), "overdue seed leads");

  const second = await generateAdvisoryBrief(firmId, clientId, null, userId);
  assert.equal(second.id, first.id, "same (firm, client, month) row");
  assert.ok(
    second.updatedAt.getTime() >= first.updatedAt.getTime(),
    "refresh bumps updatedAt",
  );
  const all = await getDb()
    .select()
    .from(clerkAdvisoryBriefsTable)
    .where(
      and(
        eq(clerkAdvisoryBriefsTable.firmId, firmId),
        eq(clerkAdvisoryBriefsTable.clientPartyId, clientId),
      ),
    );
  assert.equal(all.length, 1, "regeneration never duplicates");

  const [audit] = await getDb()
    .select({ action: auditEventsTable.action })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "advisory.brief.generate"),
        eq(auditEventsTable.entityId, first.id),
      ),
    )
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  assert.ok(audit, "generation is audited");
});

test("phrased note wins only when grounded; ungrounded numerals fall back to template", async () => {
  // No numerals at all: trivially grounded — the phrased note stores.
  const phrased = await generateAdvisoryBrief(
    firmId,
    clientId,
    fakeGateway(() =>
      JSON.stringify({
        headline: "All clear is not quite right — start with the overdue item.",
        note: "Clear the overdue return first, then the notice. The rest of the books look steady.",
      }),
    ),
    userId,
  );
  assert.equal(phrased.source, "clerk");
  assert.ok(phrased.headline.includes("start with the overdue item"));

  // A numeral the facts never stated: the grounding check discards the
  // phrased note and the template stands, source tagged honestly.
  const ungrounded = await generateAdvisoryBrief(
    firmId,
    clientId,
    fakeGateway(() =>
      JSON.stringify({
        headline: "You owe exactly 9,999,999 in penalties.",
        note: "Pay 9,999,999 today.",
      }),
    ),
    userId,
  );
  assert.equal(ungrounded.source, "template");
});

test("an un-engaged party can never mint a brief", async () => {
  await assert.rejects(
    generateAdvisoryBrief(firmId, strangerId, null, userId),
    /No such client engagement/,
  );
  const rows = await getDb()
    .select()
    .from(clerkAdvisoryBriefsTable)
    .where(eq(clerkAdvisoryBriefsTable.clientPartyId, strangerId));
  assert.equal(rows.length, 0);
});

test("list joins the client's legal name, newest first", async () => {
  const rows = await listAdvisoryBriefs(firmId, clientId);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].clientName, `Brief Client ${SALT}`);
});
