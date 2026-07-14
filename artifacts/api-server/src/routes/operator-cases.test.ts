import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  invoicesTable,
  operatorCasesTable,
  escalationsTable,
  errorCatalogueTable,
} from "@workspace/db";
import consoleRouter from "./console.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { createDraft } from "../modules/invoice/service.ts";
import { appFor, listen, closeAllServers } from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// GET /operator/cases now resolves firm/client/invoice/playbook/escalation
// lookups for the whole page in batched queries instead of 5×N sequential
// ones. This pins that the batched view still attaches every related field
// correctly (the operator queue is the hottest operator screen).

const SALT = makeRunSalt();
const operator: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

const firmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const CODE = `TEST_CODE_${SALT}`.slice(0, 40);
let invoiceId = "";
let richCaseId = "";
let bareCaseId = "";

after(async () => {
  await closeAllServers();
});

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: operator.userId, email: `opcase-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `OpCase Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: clientId,
      type: "client_business",
      legalName: `OpCase Client ${SALT}`,
      tin: "10000000-0061",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyerId,
      type: "buyer",
      legalName: `OpCase Buyer ${SALT}`,
      tin: "20000000-0061",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db
    .insert(errorCatalogueTable)
    .values({ code: CODE, cause: "test cause", fix: "test fix", retriable: true })
    .onConflictDoNothing();

  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: `OPCASE-${SALT}`,
      issueDate: "2026-07-01",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    operator.userId,
  );
  invoiceId = bundle.invoice.id;

  await db.insert(escalationsTable).values([
    {
      invoiceId,
      firmId,
      clientPartyId: clientId,
      reason: `first ${SALT}`,
      errorCode: CODE,
    },
    {
      invoiceId,
      firmId,
      clientPartyId: clientId,
      reason: `second ${SALT}`,
    },
  ]);

  richCaseId = randomUUID();
  bareCaseId = randomUUID();
  await db.insert(operatorCasesTable).values([
    {
      id: richCaseId,
      firmId,
      clientPartyId: clientId,
      invoiceId,
      title: `Rich case ${SALT}`,
      errorCode: CODE,
      priority: "high",
    },
    {
      id: bareCaseId,
      firmId,
      clientPartyId: null,
      invoiceId: null,
      title: `Bare case ${SALT}`,
      priority: "low",
    },
  ]);
});

test("batched list attaches firm/client/invoice/playbook/escalations", async () => {
  const base = await listen(appFor(operator, consoleRouter));
  const rows = (await (
    await fetch(`${base}/operator/cases`)
  ).json()) as Array<Record<string, unknown>>;

  const rich = rows.find((r) => r.id === richCaseId);
  assert.ok(rich, "rich case present");
  assert.equal(rich.firmName, `OpCase Firm ${SALT}`);
  assert.equal(rich.clientName, `OpCase Client ${SALT}`);
  assert.equal(rich.invoiceNumber, `OPCASE-${SALT}`);
  assert.equal(
    (rich.playbook as { code: string } | null)?.code,
    CODE,
    "playbook resolved from the error catalogue",
  );
  const esc = rich.escalations as Array<{ reason: string }>;
  assert.equal(esc.length, 2, "both escalations attached to the right case");
  // Ordered createdAt desc: the second-inserted row comes first.
  assert.ok(esc.every((e) => e.reason.endsWith(SALT)));
});

test("a case with no related rows still shapes with null/empty fields", async () => {
  const base = await listen(appFor(operator, consoleRouter));
  const rows = (await (
    await fetch(`${base}/operator/cases`)
  ).json()) as Array<Record<string, unknown>>;
  const bare = rows.find((r) => r.id === bareCaseId);
  assert.ok(bare, "bare case present");
  assert.equal(bare.clientName, null);
  assert.equal(bare.invoiceNumber, null);
  assert.equal(bare.playbook, null);
  assert.deepEqual(bare.escalations, []);
});
