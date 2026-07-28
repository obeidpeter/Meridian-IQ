import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkIntentFixturesTable,
  engagementsTable,
  firmsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import type { CompletionRequest } from "./gateway.ts";
import {
  INTENT_FIXTURES,
  listIntentFixtures,
  loadGrownIntentFixtures,
  mintIntentFixture,
  restoreIntentFixture,
  retireIntentFixture,
  runIntentEval,
  scrubIntentQuestion,
} from "./intent-eval.ts";
import { DomainError } from "../errors.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Grown intent corpus (round-16 idea #1). Pinned here:
//  - the scrub is deterministic and REFUSES what it cannot represent: every
//    engaged-client (and firm) name maps onto the frozen two-name synthetic
//    directory, and a question naming more distinct parties than the
//    directory holds is never stored partially scrubbed;
//  - expected keys are validated against the eval's frozen offered context
//    (fail-closed — the corpus can only pin keys the prompt actually offers);
//  - minting is idempotent per case (409 on the second attempt) and only
//    question cases qualify;
//  - retirement removes a fixture from the loader without deleting the row;
//  - a default eval run classifies static + grown fixtures together, and the
//    grown fixture is scored by the same deterministic rule.

const SALT = makeRunSalt();
const firmId = randomUUID();
const operatorId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const clientC = randomUUID();
const CLIENT_A_NAME = `Kunle Logistics ${SALT}`;
const CLIENT_B_NAME = `Ijeba Foods ${SALT}`;
const CLIENT_C_NAME = `Owerri Metals ${SALT}`;

const mintCaseId = randomUUID(); // the successful mint (then the 409 probe)
const retireCaseId = randomUUID(); // minted, then retired
const crowdedCaseId = randomUUID(); // names three parties → unrepresentable
const extractionCaseId = randomUUID(); // wrong kind → 404

const MINT_QUESTION = `When is the VAT return due for ${CLIENT_A_NAME}?`;
const SCRUBBED_QUESTION = "When is the VAT return due for Alpha Ventures Ltd?";

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  // Clean slate: the grown corpus feeds the default eval run, so this suite
  // needs exact counts. The table is only ever written by this feature.
  await db.delete(clerkIntentFixturesTable);
  await db
    .insert(usersTable)
    .values({ id: operatorId, email: `intent-fix-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({
    id: firmId,
    name: `Intent Fixtures Firm ${SALT}`,
  });
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: CLIENT_A_NAME },
    { id: clientB, type: "client_business", legalName: CLIENT_B_NAME },
    { id: clientC, type: "client_business", legalName: CLIENT_C_NAME },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "retainer", title: `if A ${SALT}` },
    { firmId, clientPartyId: clientB, type: "retainer", title: `if B ${SALT}` },
    { firmId, clientPartyId: clientC, type: "retainer", title: `if C ${SALT}` },
  ]);
  await db.insert(clerkCasesTable).values([
    {
      id: mintCaseId,
      kind: "question",
      question: MINT_QUESTION,
      firmId,
      createdBy: operatorId,
    },
    {
      id: retireCaseId,
      kind: "question",
      question: "Which of our invoices are still waiting on the rails?",
      firmId,
      createdBy: operatorId,
    },
    {
      id: crowdedCaseId,
      kind: "question",
      question: `Compare what ${CLIENT_A_NAME}, ${CLIENT_B_NAME} and ${CLIENT_C_NAME} owe us`,
      firmId,
      createdBy: operatorId,
    },
    {
      id: extractionCaseId,
      kind: "extraction",
      sourceType: "text",
      sourceName: `intent-fix-${SALT}.txt`,
      sourceText: "INVOICE 001",
      firmId,
      createdBy: operatorId,
    },
  ]);
});

after(async () => {
  const db = getDb();
  const caseIds = [mintCaseId, retireCaseId, crowdedCaseId, extractionCaseId];
  await db
    .delete(clerkIntentFixturesTable)
    .where(inArray(clerkIntentFixturesTable.caseId, caseIds));
  await db.delete(clerkCasesTable).where(inArray(clerkCasesTable.id, caseIds));
  await db.delete(engagementsTable).where(eq(engagementsTable.firmId, firmId));
  await restoreClerkFlag();
});

const ids = (names: string[], tins: string[] = []) => ({ names, tins });

test("scrub maps known names onto the synthetic directory in appearance order", () => {
  // The longest surface form claims its whole span (the contained "Akintola"
  // fragment consumes no slot); directory slots go in order of first
  // appearance in the question; matching is case-insensitive.
  const out = scrubIntentQuestion(
    "Invoice AKINTOLA HAULAGE WEST for the Dangote job",
    ids(["Akintola Haulage West", "Dangote", "Akintola"]),
  );
  assert.equal(
    out,
    "Invoice Alpha Ventures Ltd for the Beta Trading Co job",
  );
});

test("scrub is word-bounded: unrelated words survive known short names", () => {
  assert.equal(
    scrubIntentQuestion(
      "What VAT rate applies to rice?",
      ids(["Zenith Holdings", "at"]),
    ),
    "What VAT rate applies to rice?",
  );
});

test("scrub refuses a question naming more parties than the directory", () => {
  assert.equal(
    scrubIntentQuestion(
      "Alpha Co vs Bravo Co vs Charlie Co",
      ids(["Alpha Co", "Bravo Co", "Charlie Co"]),
    ),
    null,
  );
});

test("scrub catches surface variants: NBSP, homoglyphs, informal short forms", () => {
  // NBSP inside the name (routine in pasted text) — NFKC + whitespace
  // collapse still matches.
  assert.equal(
    scrubIntentQuestion(
      "When is VAT due for Acme Ltd?",
      ids(["Acme Ltd"]),
    ),
    "When is VAT due for Alpha Ventures Ltd?",
  );
  // Kelvin-sign K homoglyph folds to K under NFKC and scrubs.
  assert.equal(
    scrubIntentQuestion("Has Kobo Ltd paid us?", ids(["Kobo Ltd"])),
    "Has Alpha Ventures Ltd paid us?",
  );
  // The informal short form of a long legal name shares its slot.
  assert.equal(
    scrubIntentQuestion(
      "What is unsubmitted for Acme?",
      ids(["Acme Ventures Nigeria Ltd"]),
    ),
    "What is unsubmitted for Alpha Ventures Ltd?",
  );
});

test("scrub scrubs known TINs and refuses residual detections", () => {
  // A known TIN (spacing-tolerant) becomes the shaped synthetic.
  assert.equal(
    scrubIntentQuestion(
      "Is TIN 12345678-0001 registered to us?",
      ids([], ["12345678-0001"]),
    ),
    "Is TIN 00000001-0001 registered to us?",
  );
  // A known name that would still match INSIDE the directory replacement
  // ("Ventures" inside "Alpha Ventures Ltd") is a refusal, never a hybrid
  // or a leak — the verification pass fails closed.
  assert.equal(
    scrubIntentQuestion(
      "What does Acme Ventures owe us?",
      ids(["Acme Ventures", "Ventures"]),
    ),
    null,
  );
});

test("expected keys outside the frozen offered context are refused", async () => {
  for (const expected of [
    { claimKey: `not.offered.${SALT}` },
    { claimKey: "vat.filing-deadline", month: "2027-01" },
    { claimKey: "vat.filing-deadline", client: "c9" },
  ]) {
    await assert.rejects(
      () => mintIntentFixture({ caseId: mintCaseId, expected }, operatorId),
      (err: unknown) =>
        err instanceof DomainError &&
        err.code === "BAD_EXPECTED" &&
        err.status === 400,
    );
  }
});

test("only question cases mint", async () => {
  for (const caseId of [extractionCaseId, randomUUID()]) {
    await assert.rejects(
      () =>
        mintIntentFixture(
          { caseId, expected: { claimKey: "vat.filing-deadline" } },
          operatorId,
        ),
      (err: unknown) =>
        err instanceof DomainError && err.code === "NOT_FOUND",
    );
  }
});

test("a crowded question is refused, never stored partially scrubbed", async () => {
  await assert.rejects(
    () =>
      mintIntentFixture(
        { caseId: crowdedCaseId, expected: { claimKey: "vat.filing-deadline" } },
        operatorId,
      ),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "UNREPRESENTABLE" &&
      err.status === 422,
  );
  assert.equal((await listIntentFixtures()).length, 0);
});

test("minting stores the SCRUBBED question; a second mint is a 409", async () => {
  const fixture = await mintIntentFixture(
    {
      caseId: mintCaseId,
      expected: { claimKey: "vat.filing-deadline", client: "none" },
    },
    operatorId,
  );
  assert.equal(fixture.question, SCRUBBED_QUESTION);
  assert.ok(
    !fixture.question.includes(SALT),
    "no tenant vocabulary survives into the corpus",
  );
  assert.match(fixture.label, /^grown: /);
  await assert.rejects(
    () =>
      mintIntentFixture(
        { caseId: mintCaseId, expected: { claimKey: "vat.filing-deadline" } },
        operatorId,
      ),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "ALREADY_MINTED" &&
      err.status === 409,
  );
});

test("retire/restore drive the loader without deleting the row", async () => {
  const second = await mintIntentFixture(
    {
      caseId: retireCaseId,
      label: "retire me",
      expected: { claimKey: "data.unsubmitted_invoices" },
    },
    operatorId,
  );
  const retired = await retireIntentFixture(second.id, operatorId);
  assert.ok(retired.retiredAt, "retirement is stamped");
  const loaded = await loadGrownIntentFixtures();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].question, SCRUBBED_QUESTION);
  assert.match(loaded[0].key, /^grown-/);
  assert.equal((await listIntentFixtures()).length, 2, "the row survives");
  const restored = await restoreIntentFixture(second.id, operatorId);
  assert.equal(restored.retiredAt, null);
  assert.equal((await loadGrownIntentFixtures()).length, 2);
  // Retire again so the grown-run test below sees exactly one active
  // fixture; an unknown id is a 404.
  await retireIntentFixture(second.id, operatorId);
  await assert.rejects(
    () => retireIntentFixture(randomUUID(), operatorId),
    (err: unknown) =>
      err instanceof DomainError && err.code === "NOT_FOUND",
  );
});

test("a default run classifies static + grown fixtures together", async () => {
  const prompts: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    prompts.push(req);
    const user = String(req.user);
    const fixture = INTENT_FIXTURES.find((f) => user.includes(f.question));
    if (fixture) {
      return JSON.stringify({
        claimKey: fixture.expected.claimKey,
        category: "unknown",
        month: fixture.expected.month ?? "none",
        client: fixture.expected.client ?? "none",
      });
    }
    if (user.includes(SCRUBBED_QUESTION)) {
      return JSON.stringify({
        claimKey: "vat.filing-deadline",
        category: "unknown",
        month: "none",
        client: "none",
      });
    }
    throw new Error("unknown eval question");
  });
  const run = await runIntentEval(null, gateway);
  assert.equal(run.fixtureCount, INTENT_FIXTURES.length + 1);
  assert.equal(run.correctCount, INTENT_FIXTURES.length + 1);
  const grown = run.results.find((r) => r.key.startsWith("grown-"));
  assert.ok(grown && grown.correct, "the grown fixture is scored");
  // The grown question rode the production prompt assembly like any other.
  const grownPrompt = prompts.find((p) =>
    String(p.user).includes(SCRUBBED_QUESTION),
  );
  assert.ok(grownPrompt);
  assert.match(String(grownPrompt.user), /-----BEGIN QUESTION-----/);
});
