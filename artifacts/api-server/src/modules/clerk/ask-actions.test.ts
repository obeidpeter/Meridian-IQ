import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  clerkActionDecisionsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import { ACTIONS_FLAG_KEY } from "./actions.ts";
import { askClerk, type AskAnswer } from "./ask.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Do with Clerk (round 31): action-bearing plans. Pinned invariants:
//  - act.* keys enter the plan schema's closed enum ONLY when the route said
//    the principal could approve that kind AND the actions flag is on —
//    dark or capability-less means the keys simply don't exist;
//  - an act step resolves to a LIVE proposalForKind assembly rendered as an
//    approvable section (kind, client, capped target ids) — and NOTHING
//    executes: the decisions ledger stays untouched by an answer;
//  - a firm asker must name a listed client (per-client batches); a client
//    asker is FORCED to its own party (SEC-03) whatever the model picked;
//  - an act step never takes a month; an empty assembly answers honestly.

const SALT = makeRunSalt();

const firmId = randomUUID();
const userId = randomUUID();
const clientA = randomUUID(); // engaged, carries overdue paper
const clientB = randomUUID(); // engaged, NO eligible paper
const buyer = randomUUID();

const ALL_KINDS = [
  "submit_overdue" as const,
  "retry_failed" as const,
  "draft_chasers" as const,
];

let overdueA1: string;
let overdueA2: string;
let freshA: string;

// Extract the plan schema's closed key enum from a captured request.
function keyEnum(req: CompletionRequest): string[] {
  const steps = (req.jsonSchema as { properties: { steps: { items: { properties: { key: { enum: string[] } } } } } })
    .properties.steps.items.properties.key;
  return steps.enum;
}

function planGateway(
  steps: Array<{ key: string; month?: string; client?: string }>,
  prompts?: CompletionRequest[],
) {
  return fakeGateway((req) => {
    prompts?.push(req);
    return JSON.stringify({
      category: "unknown",
      steps: steps.map((s) => ({
        key: s.key,
        month: s.month ?? "none",
        client: s.client ?? "none",
      })),
    });
  });
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(featureFlagsTable)
    .values({
      key: ACTIONS_FLAG_KEY,
      enabled: false,
      releaseTag: "R3",
      description: "Clerk proposed actions (test seed)",
    })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `ask-act-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `AskAct Firm ${SALT}` });
  // Per-firm opt-in only — the platform default stays dark.
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business",
      legalName: `AskAct Alpha ${SALT}`,
      tin: "30000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: clientB,
      type: "client_business",
      legalName: `AskAct Beta ${SALT}`,
      tin: "30000000-0002",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `AskAct Buyer ${SALT}`,
      tin: "40000000-0001",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "readiness_assessment", title: "aa" },
    { firmId, clientPartyId: clientB, type: "readiness_assessment", title: "ab" },
  ]);
  const LINE = {
    description: "Goods",
    quantity: "1",
    unitPrice: "1000",
    vatRate: "0.075",
  };
  let n = 0;
  const draft = async (issueDate: string) => {
    n += 1;
    const bundle = await createDraft(
      {
        firmId,
        supplierPartyId: clientA,
        buyerPartyId: buyer,
        invoiceNumber: `ASKACT-${SALT}-${n}`,
        issueDate,
        dueDate: null,
        lines: [LINE],
      },
      userId,
    );
    return bundle.invoice.id;
  };
  overdueA1 = await draft(daysAgo(30));
  overdueA2 = await draft(daysAgo(20));
  freshA = await draft(daysAgo(0));
});

after(async () => {
  await restoreClerkFlag();
});

test("act keys ride the closed enum only when offered; dark flag or no capability removes them", async () => {
  // Offered: firm asker with every kind.
  const offered: CompletionRequest[] = [];
  await askClerk("Submit the overdue paper.", userId, planGateway([], offered), {
    firmId,
    actionKinds: ALL_KINDS,
  });
  assert.ok(keyEnum(offered[0]).includes("act.submit_overdue"));
  assert.ok(keyEnum(offered[0]).includes("act.retry_failed"));
  assert.ok(keyEnum(offered[0]).includes("act.draft_chasers"));

  // No capability: the keys never exist, whatever the question says.
  const noCap: CompletionRequest[] = [];
  await askClerk("Submit the overdue paper.", userId, planGateway([], noCap), {
    firmId,
    actionKinds: [],
  });
  assert.ok(!keyEnum(noCap[0]).some((k) => k.startsWith("act.")));

  // Flag dark (a firm the override never reached): the keys never exist.
  const darkFirm = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: darkFirm, name: `AskAct Dark ${SALT}` });
  const dark: CompletionRequest[] = [];
  await askClerk("Submit the overdue paper.", userId, planGateway([], dark), {
    firmId: darkFirm,
    actionKinds: ALL_KINDS,
  });
  assert.ok(!keyEnum(dark[0]).some((k) => k.startsWith("act.")));
});

test("an act step becomes an approvable proposal section — and executes nothing", async () => {
  const before = await getDb()
    .select({ id: clerkActionDecisionsTable.id })
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.firmId, firmId));
  // clientOptions sort by legal name: Alpha = c1, Beta = c2.
  const row = await askClerk(
    "Submit Alpha's overdue invoices.",
    userId,
    planGateway([{ key: "act.submit_overdue", client: "c1" }]),
    { firmId, actionKinds: ALL_KINDS },
  );
  assert.equal(row.status, "approved");
  const answer = row.answer as AskAnswer;
  assert.equal(answer.answered, true);
  assert.equal(answer.plan?.length, 1);
  assert.equal(answer.plan?.[0].key, "act.submit_overdue");
  assert.equal(answer.sections?.length, 1);
  const section = answer.sections![0];
  assert.ok(section.action, "the approve payload rides the section");
  assert.equal(section.action!.kind, "submit_overdue");
  assert.equal(section.action!.clientPartyId, clientA);
  assert.ok(section.action!.invoiceIds.includes(overdueA1));
  assert.ok(section.action!.invoiceIds.includes(overdueA2));
  assert.ok(
    !section.action!.invoiceIds.includes(freshA),
    "in-window paper is not proposed",
  );
  assert.equal(section.action!.targetCount, section.action!.invoiceIds.length);
  assert.match(section.text, /Nothing runs until you approve it below/);

  const after = await getDb()
    .select({ id: clerkActionDecisionsTable.id })
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.firmId, firmId));
  assert.equal(after.length, before.length, "an answer never executes");
});

test("a firm asker must name the client; an act step never takes a month", async () => {
  const noClient = await askClerk(
    "Submit the overdue invoices.",
    userId,
    planGateway([{ key: "act.submit_overdue" }]),
    { firmId, actionKinds: ALL_KINDS },
  );
  assert.equal(noClient.status, "escalated");
  assert.match(
    (noClient.answer as AskAnswer).refusalReason ?? "",
    /assembled per client/,
  );

  const monthPinned = await askClerk(
    "Submit Alpha's overdue invoices for May.",
    userId,
    planGateway([
      { key: "act.submit_overdue", client: "c1", month: "2026-05" },
    ]),
    { firmId, actionKinds: ALL_KINDS },
  );
  assert.equal(monthPinned.status, "escalated");
  assert.match(
    (monthPinned.answer as AskAnswer).refusalReason ?? "",
    /cannot be filtered to a month/,
  );
});

test("a client asker's act step is forced to its own party (SEC-03)", async () => {
  const row = await askClerk(
    "Submit my overdue invoices.",
    userId,
    // The model picked NO client; the principal's party wins regardless.
    planGateway([{ key: "act.submit_overdue" }]),
    {
      firmId,
      clientScoped: true,
      clientPartyId: clientA,
      actionKinds: ALL_KINDS,
    },
  );
  assert.equal(row.status, "approved");
  const answer = row.answer as AskAnswer;
  assert.equal(answer.sections?.[0].action?.clientPartyId, clientA);
});

test("a mixed data+act plan answers both parts; an empty assembly answers honestly", async () => {
  const row = await askClerk(
    "What's overdue, and submit Beta's overdue invoices.",
    userId,
    planGateway([
      { key: "data.overdue_submissions" },
      { key: "act.submit_overdue", client: "c2" },
    ]),
    { firmId, actionKinds: ALL_KINDS },
  );
  assert.equal(row.status, "approved");
  const answer = row.answer as AskAnswer;
  assert.equal(answer.sections?.length, 2);
  assert.equal(answer.sections![0].dataIntent, "data.overdue_submissions");
  assert.ok(!answer.sections![0].action, "data sections carry no payload");
  // Beta has no paper at all: the act section answers honestly with no
  // approve payload — an empty batch is an answer, not a refusal.
  assert.ok(!answer.sections![1].action);
  assert.match(answer.sections![1].text, /nothing is currently eligible/i);
});
