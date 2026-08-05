import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  usersTable,
  membershipsTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  auditEventsTable,
} from "@workspace/db";
import {
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  fakeGateway,
  saveAndEnableClerkFlag,
  restoreClerkFlag,
} from "../clerk/test-support.ts";
import type { CompletionRequest } from "../clerk/gateway.ts";
import {
  eventually,
  inboundApp,
  makeCsvAttachment,
  makePdfAttachment,
  okExtraction,
  seedInboundClient,
  textPdf,
  withEnv,
} from "./test-support.ts";
import {
  maskInboundSender,
  processInboundEmail,
  resolveInboundSender,
} from "./email.ts";

// Inbound email intake rail. Pinned invariants:
//  - fail-closed gate: INBOUND_EMAIL_TOKEN unset → the rail is dark (404 for
//    every request); wrong token → 401;
//  - anti-probe: identical 202 {received} whether or not the sender resolves;
//    an unresolvable sender only leaves an audit row with a MASKED address;
//  - a resolved client sender's attachments walk the ordinary capture path
//    (text PDF → text extraction, PNG → vision), stamped with the right
//    firm/creator;
//  - unsupported types, duplicate redeliveries and an exhausted budget all
//    audit-skip — nothing throws, nothing double-creates.

const SALT = makeRunSalt();
const TOKEN = `inbound-secret-${SALT}`;
const DOMAIN = `${SALT}.inbound-test.local`;

// Fixture ids minted by seedInboundClient in before(); only the ones the
// tests themselves assert on live at module scope.
let firm1: string;
let clientParty: string;
let clientUserId: string;

const CLIENT_EMAIL = `client@${DOMAIN}`;
const STAFF_EMAIL = `staff@${DOMAIN}`;
const BROKE_EMAIL = `broke@${DOMAIN}`;
const CAPPED_EMAIL = `capped@${DOMAIN}`;

const PNG_B64 = Buffer.from(`png-bytes-${SALT}`).toString("base64");

const savedToken = process.env.INBOUND_EMAIL_TOKEN;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  // The three fixture clients ride the shared seeder (test-support.ts): one
  // canonical firm/party/user/client_user-membership write per client.
  ({ firmId: firm1, partyId: clientParty, userId: clientUserId } =
    await seedInboundClient(db, {
      firmName: `Inbound Firm ${SALT}`,
      partyName: `Inbound Client ${SALT}`,
      email: CLIENT_EMAIL,
    }));
  const broke = await seedInboundClient(db, {
    firmName: `Inbound Broke Firm ${SALT}`,
    partyName: `Inbound Broke ${SALT}`,
    email: BROKE_EMAIL,
  });
  await seedInboundClient(db, {
    firmName: `Inbound Capped Firm ${SALT}`,
    partyName: `Inbound Capped ${SALT}`,
    email: CAPPED_EMAIL,
  });
  // A staff address in the resolved client's firm: resolves to nothing (the
  // rail only ever captures on behalf of a client).
  const staffUserId = randomUUID();
  await db.insert(usersTable).values({ id: staffUserId, email: STAFF_EMAIL });
  await db
    .insert(membershipsTable)
    .values({ userId: staffUserId, firmId: firm1, role: "firm_admin" });
  // Spend the broke firm's entire default allowance (2,000,000 tokens) so its
  // client's inbound attachments must budget-skip. Append-only ledger — the
  // random firm id keeps runs independent.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: broke.firmId,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `inbound-budget-${SALT}`,
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 1_500_000,
    completionTokens: 500_000,
  });
});

after(async () => {
  if (savedToken === undefined) delete process.env.INBOUND_EMAIL_TOKEN;
  else process.env.INBOUND_EMAIL_TOKEN = savedToken;
  await restoreClerkFlag();
  await closeAllServers();
});

function emailBody(sender: string, attachments: unknown[]): string {
  return JSON.stringify({ sender, subject: `Invoice ${SALT}`, attachments });
}

const pdfAttachment = makePdfAttachment(SALT);
const pngAttachment = (tag: string) => ({
  filename: `${tag}-${SALT}.png`,
  contentType: "image/png",
  contentBase64: PNG_B64,
});

test("token unset: the rail is dark — 404 even for a well-formed request", async () => {
  delete process.env.INBOUND_EMAIL_TOKEN;
  const base = await listen(inboundApp());
  const res = await fetch(`${base}/api/inbound/email`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": TOKEN },
    body: emailBody(CLIENT_EMAIL, [pdfAttachment("dark")]),
  });
  assert.equal(res.status, 404);
});

test("wrong token: 401; no processing", async () => {
  process.env.INBOUND_EMAIL_TOKEN = TOKEN;
  const base = await listen(inboundApp());
  const res = await fetch(`${base}/api/inbound/email`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": "nope" },
    body: emailBody(CLIENT_EMAIL, [pdfAttachment("badtoken")]),
  });
  assert.equal(res.status, 401);
  const missing = await fetch(`${base}/api/inbound/email`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: emailBody(CLIENT_EMAIL, [pdfAttachment("badtoken")]),
  });
  assert.equal(missing.status, 401);
});

test("unknown sender: 202 identical to success, nothing created, masked audit row", async () => {
  process.env.INBOUND_EMAIL_TOKEN = TOKEN;
  const base = await listen(inboundApp());
  const ghost = `unknown@${DOMAIN}`;
  const filename = `ghost-${SALT}.pdf`;

  const res = await fetch(`${base}/api/inbound/email?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: emailBody(ghost, [
      { filename, contentType: "application/pdf", contentBase64: textPdf("ghost", SALT) },
    ]),
  });
  assert.equal(res.status, 202);
  const unknownBody = await res.json();
  assert.deepEqual(unknownBody, { received: 1 });

  // ANTI-PROBE: a resolved sender's response is byte-for-byte the same shape.
  const resolvedRes = await fetch(`${base}/api/inbound/email?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: emailBody(CLIENT_EMAIL, [
      // Unsupported type: the detached pipeline audit-skips it, so this route
      // call needs no model provider.
      { filename: `probe-${SALT}.csv`, contentType: "text/csv", contentBase64: PNG_B64 },
    ]),
  });
  assert.equal(resolvedRes.status, 202);
  assert.deepEqual(await resolvedRes.json(), unknownBody);

  // The drop is durable, with the address MASKED (first 2 chars + domain).
  const ignored = await eventually(async () => {
    const rows = await getDb()
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.action, "inbound.email.ignored"))
      .orderBy(desc(auditEventsTable.seq))
      .limit(20);
    return rows.find(
      (r) => (r.after as { sender?: string })?.sender === `un***@${DOMAIN}`,
    );
  }, "ignored audit row");
  assert.equal(
    (ignored.after as { attachments?: number }).attachments,
    1,
    "counts only, never content",
  );

  // The resolved-but-unsupported email also left its (skip-only) receipt.
  const received = await eventually(async () => {
    const rows = await getDb()
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.action, "inbound.email.received"))
      .orderBy(desc(auditEventsTable.seq))
      .limit(20);
    return rows.find((r) => r.firmId === firm1);
  }, "received audit row");
  assert.deepEqual((received.after as { caseIds?: string[] }).caseIds, []);
  assert.deepEqual((received.after as { skipped?: unknown }).skipped, [
    { filename: `probe-${SALT}.csv`, reason: "UNSUPPORTED_TYPE" },
  ]);

  // Nothing was created for either email.
  const cases = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(inArray(clerkCasesTable.sourceName, [filename, `probe-${SALT}.csv`]));
  assert.equal(cases.length, 0);
});

test("sender masking and resolution", async () => {
  assert.equal(maskInboundSender("objay2026@gmail.com"), "ob***@gmail.com");
  assert.equal(maskInboundSender("a@b.c"), "a***@b.c");
  assert.equal(maskInboundSender("not-an-email"), "no***");

  // Case-insensitive match on users.email; staff resolve to nothing (the
  // rail only captures on behalf of clients).
  const resolved = await resolveInboundSender(
    `Client@${DOMAIN.toUpperCase()}`,
  );
  assert.deepEqual(resolved, {
    userId: clientUserId,
    firmId: firm1,
    clientPartyId: clientParty,
  });
  assert.equal(await resolveInboundSender(STAFF_EMAIL), null);
  assert.equal(await resolveInboundSender(`nobody@${DOMAIN}`), null);
});

test("resolved sender: PDF walks the text path, PNG the vision path, cases stamped for the client", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okExtraction();
  });
  const input = {
    sender: CLIENT_EMAIL,
    subject: `Invoices ${SALT}`,
    attachments: [pdfAttachment("main"), pngAttachment("main")],
  };
  const result = await processInboundEmail(input, gateway);
  assert.equal(result.resolved, true);
  assert.equal(result.caseIds.length, 2);
  assert.deepEqual(result.skipped, []);

  // Each attachment makes one triage call (whose okExtraction() answer fails
  // the triage schema and falls back to the invoice lane — triage.test.ts
  // covers the lane switch) and one extraction call.
  const extractCalls = calls.filter((c) => c.schemaName === "invoice_extraction");
  const triageCalls = calls.filter((c) => c.schemaName === "document_triage");
  assert.equal(extractCalls.length, 2, "one extraction per attachment");
  assert.equal(triageCalls.length, 2, "one triage call per attachment");
  const textCall = extractCalls.find((c) => typeof c.user === "string");
  assert.ok(textCall, "the text PDF travelled as fenced text");
  assert.match(textCall.user as string, /INVOICE main/);
  const visionCall = extractCalls.find((c) => Array.isArray(c.user));
  assert.ok(visionCall, "the PNG travelled as an image part");
  assert.ok(
    (visionCall.user as Array<{ type: string }>).some(
      (p) => p.type === "image_url",
    ),
  );

  const rows = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(inArray(clerkCasesTable.id, result.caseIds));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.firmId, firm1, "case owned by the sender's firm");
    assert.equal(row.createdBy, clientUserId, "created by the resolved client");
    assert.equal(row.status, "extracted");
  }
  const pdfRow = rows.find((r) => r.sourceType === "pdf");
  assert.ok(pdfRow);
  assert.equal(pdfRow.sourceName, `main-${SALT}.pdf`);
  assert.match(pdfRow.sourceText ?? "", /INVOICE main/);
  const pngRow = rows.find((r) => r.sourceType === "image");
  assert.ok(pngRow);
  assert.equal(pngRow.sourceName, `main-${SALT}.png`);
  assert.ok(pngRow.sourceImageB64, "image bytes stored for retry");

  // Pointer-only receipt names both cases.
  const receipts = await getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "inbound.email.received"))
    .orderBy(desc(auditEventsTable.seq))
    .limit(20);
  const receipt = receipts.find((r) =>
    result.caseIds.every((id) =>
      ((r.after as { caseIds?: string[] })?.caseIds ?? []).includes(id),
    ),
  );
  assert.ok(receipt, "received audit row carries the case ids");
  assert.equal(receipt.actorId, clientUserId);
  assert.equal(receipt.firmId, firm1);
  assert.equal(
    (receipt.after as { sender?: string }).sender,
    `cl***@${DOMAIN}`,
    "sender masked even when resolved",
  );

  // Provider redelivery of the SAME email: the duplicate guard audit-skips
  // both attachments and creates no second case.
  const redelivered = await processInboundEmail(input, gateway);
  assert.equal(redelivered.resolved, true);
  assert.deepEqual(redelivered.caseIds, []);
  assert.deepEqual(
    redelivered.skipped.map((s) => s.reason),
    ["DUPLICATE_SOURCE", "DUPLICATE_SOURCE"],
  );
  const again = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(
      inArray(clerkCasesTable.sourceName, [
        `main-${SALT}.pdf`,
        `main-${SALT}.png`,
      ]),
    );
  assert.equal(again.length, 2, "still exactly one case per attachment");
});

test("daily attachment cap: over-cap attachments audit-skip, counted from the durable receipts", async () => {
  await withEnv("INBOUND_EMAIL_DAILY_CAP", "2", async () => {
    const csv = makeCsvAttachment(SALT, PNG_B64);
    // Fresh firm, cap 2, three attachments: the first two consume the day's
    // allowance (and then skip as unsupported — no provider needed), the
    // third is refused by the cap itself.
    const first = await processInboundEmail({
      sender: CAPPED_EMAIL,
      attachments: [csv("cap-a"), csv("cap-b"), csv("cap-c")],
    });
    assert.equal(first.resolved, true);
    assert.deepEqual(
      first.skipped.map((s) => s.reason),
      ["UNSUPPORTED_TYPE", "UNSUPPORTED_TYPE", "INBOUND_DAILY_CAP"],
    );

    // The receipt of the first email (3 attachments in caseIds+skipped) now
    // exceeds the cap, so a second email is refused entirely — the count
    // comes from the audit trail, not process memory.
    const second = await processInboundEmail({
      sender: CAPPED_EMAIL,
      attachments: [csv("cap-d")],
    });
    assert.equal(second.resolved, true);
    assert.deepEqual(
      second.skipped.map((s) => s.reason),
      ["INBOUND_DAILY_CAP"],
    );
  });
});

test("exhausted budget: audit-skip before any provider work, nothing thrown", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okExtraction();
  });
  const result = await processInboundEmail(
    { sender: BROKE_EMAIL, attachments: [pngAttachment("broke")] },
    gateway,
  );
  assert.equal(result.resolved, true);
  assert.deepEqual(result.caseIds, []);
  assert.deepEqual(
    result.skipped.map((s) => s.reason),
    ["CLERK_BUDGET_EXHAUSTED"],
  );
  assert.equal(providerCalls, 0, "the budget gate fires before the provider");
  const cases = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.sourceName, `broke-${SALT}.png`));
  assert.equal(cases.length, 0);
});
