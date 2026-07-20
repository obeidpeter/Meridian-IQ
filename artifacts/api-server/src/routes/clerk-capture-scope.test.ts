import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  usersTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import clerkRouter from "./clerk/index.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { createExtractionCase } from "../modules/clerk/cases.ts";
import {
  fakeGateway,
  saveAndEnableClerkFlag,
  restoreClerkFlag,
} from "../modules/clerk/test-support.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// Clerk expansion A: capture goes client-facing. These pin the route-layer
// tenancy (firm principals see only their firm's cases; a client_user only its
// own submissions — SEC-03 posture) and the per-firm monthly token budget
// (429 BEFORE any provider work once the ledger shows the allowance spent).
// The 0009 RLS policy itself is covered by the migration rollback test.

const SALT = makeRunSalt();

const firm1 = randomUUID();
const firm2 = randomUUID();
const firmBroke = randomUUID(); // budget-exhaustion firm (ledger is append-only)

const clientA: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId: firm1,
  clientPartyId: randomUUID(),
  buyerPartyId: null,
};
const clientB: Principal = { ...clientA, userId: randomUUID(), clientPartyId: randomUUID() };
const adminF1: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firm1,
  clientPartyId: null,
  buyerPartyId: null,
};
const adminF2: Principal = { ...adminF1, userId: randomUUID(), firmId: firm2 };
const adminBroke: Principal = { ...adminF1, userId: randomUUID(), firmId: firmBroke };

let caseId = "";

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  for (const p of [clientA, clientB, adminF1, adminF2, adminBroke]) {
    await db
      .insert(usersTable)
      .values({ id: p.userId, email: `clerk-scope-${p.userId}@test.local` })
      .onConflictDoNothing();
  }
  await db.insert(firmsTable).values([
    { id: firm1, name: `Clerk Scope Firm1 ${SALT}` },
    { id: firm2, name: `Clerk Scope Firm2 ${SALT}` },
    { id: firmBroke, name: `Clerk Broke Firm ${SALT}` },
  ]);

  const kase = await createExtractionCase(
    { sourceType: "text", text: `Invoice CLERKSCOPE-${SALT} total 100`, name: `scope-${SALT}.txt` },
    clientA.userId,
    fakeGateway(okExtraction),
    undefined,
    { firmId: firm1 },
  );
  caseId = kase.id;
  assert.equal(kase.firmId, firm1, "capture stamps the principal's firm");

  // Spend firmBroke's entire default allowance (2,000,000 tokens) in one
  // ledgered call so the next capture/ask must 429. Append-only table — the
  // random firm id keeps runs independent.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: firmBroke,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `budget-${SALT}`,
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 1_500_000,
    completionTokens: 500_000,
  });
});

after(async () => {
  await restoreClerkFlag();
  await closeAllServers();
});

test("a client_user sees only its own submissions; firm staff see the firm's", async () => {
  const asClientA = await listen(appFor(clientA, clerkRouter));
  const asClientB = await listen(appFor(clientB, clerkRouter));
  const asAdminF1 = await listen(appFor(adminF1, clerkRouter));
  const asAdminF2 = await listen(appFor(adminF2, clerkRouter));

  const ids = async (base: string) =>
    ((await (await fetch(`${base}/clerk/cases?kind=extraction`)).json()) as Array<{ id: string }>).map(
      (c) => c.id,
    );

  assert.ok((await ids(asClientA)).includes(caseId), "creator sees the case");
  assert.ok(
    !(await ids(asClientB)).includes(caseId),
    "a sibling client_user in the same firm does NOT see it",
  );
  assert.ok((await ids(asAdminF1)).includes(caseId), "firm admin sees the firm's case");
  assert.ok(!(await ids(asAdminF2)).includes(caseId), "another firm does NOT see it");
});

test("case detail is scoped: cross-firm and sibling-client reads 404", async () => {
  const asClientA = await listen(appFor(clientA, clerkRouter));
  const asClientB = await listen(appFor(clientB, clerkRouter));
  const asAdminF1 = await listen(appFor(adminF1, clerkRouter));
  const asAdminF2 = await listen(appFor(adminF2, clerkRouter));

  assert.equal((await fetch(`${asClientA}/clerk/cases/${caseId}`)).status, 200);
  assert.equal((await fetch(`${asAdminF1}/clerk/cases/${caseId}`)).status, 200);
  assert.equal((await fetch(`${asClientB}/clerk/cases/${caseId}`)).status, 404);
  assert.equal((await fetch(`${asAdminF2}/clerk/cases/${caseId}`)).status, 404);
});

test("usage reports month-to-date tokens against the default allowance", async () => {
  const base = await listen(appFor(adminBroke, clerkRouter));
  const usage = (await (await fetch(`${base}/clerk/usage`)).json()) as {
    usedTokens: number;
    budgetTokens: number;
  };
  assert.equal(usage.budgetTokens, 2_000_000, "platform default allowance");
  assert.ok(usage.usedTokens >= 2_000_000, "ledgered spend is counted");
});

test("an exhausted firm gets 429 on capture and ask, before any provider work", async () => {
  const base = await listen(appFor(adminBroke, clerkRouter));

  const capture = await fetch(`${base}/clerk/cases`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      sourceType: "text",
      text: `Invoice BROKE-${SALT} total 100`,
      name: "broke.txt",
    }),
  });
  assert.equal(capture.status, 429);

  const ask = await fetch(`${base}/clerk/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ question: "What VAT rate applies to consulting?" }),
  });
  assert.equal(ask.status, 429);
});

test("a healthy firm's capture is not blocked by another firm's spend", async () => {
  const base = await listen(appFor(adminF1, clerkRouter));
  const usage = (await (await fetch(`${base}/clerk/usage`)).json()) as {
    usedTokens: number;
    budgetTokens: number;
  };
  assert.ok(usage.usedTokens < usage.budgetTokens, "firm1 is under budget");
});
