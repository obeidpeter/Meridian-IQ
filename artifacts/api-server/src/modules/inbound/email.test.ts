import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  membershipsTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  auditEventsTable,
} from "@workspace/db";
import inboundRouter from "../../routes/inbound.ts";
import { errorHandler } from "../../middleware/error.ts";
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

const firm1 = randomUUID();
const firmBroke = randomUUID();
const clientParty = randomUUID();
const brokePartyId = randomUUID();
const clientUserId = randomUUID();
const staffUserId = randomUUID();
const brokeUserId = randomUUID();

const CLIENT_EMAIL = `client@${DOMAIN}`;
const STAFF_EMAIL = `staff@${DOMAIN}`;
const BROKE_EMAIL = `broke@${DOMAIN}`;

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

// A one-page PDF whose content stream draws real text (the clerk-scan.test
// fixture), so extraction stays on the text path.
function textPdf(tag: string): string {
  const streamBody = `BT /F1 14 Tf 20 50 Td (INVOICE ${tag} ${SALT}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${streamBody.length} >> stream
${streamBody}
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

const PNG_B64 = Buffer.from(`png-bytes-${SALT}`).toString("base64");

function inboundApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use((req, _res, next) => {
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use("/api", inboundRouter);
  app.use(errorHandler);
  return app;
}

async function eventually<T>(
  probe: () => Promise<T | null | undefined>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const savedToken = process.env.INBOUND_EMAIL_TOKEN;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firm1, name: `Inbound Firm ${SALT}` },
    { id: firmBroke, name: `Inbound Broke Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Inbound Client ${SALT}` },
    { id: brokePartyId, type: "client_business", legalName: `Inbound Broke ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: clientUserId, email: CLIENT_EMAIL },
    { id: staffUserId, email: STAFF_EMAIL },
    { id: brokeUserId, email: BROKE_EMAIL },
  ]);
  await db.insert(membershipsTable).values([
    {
      userId: clientUserId,
      firmId: firm1,
      role: "client_user",
      clientPartyId: clientParty,
    },
    { userId: staffUserId, firmId: firm1, role: "firm_admin" },
    {
      userId: brokeUserId,
      firmId: firmBroke,
      role: "client_user",
      clientPartyId: brokePartyId,
    },
  ]);
  // Spend the broke firm's entire default allowance (2,000,000 tokens) so its
  // client's inbound attachments must budget-skip. Append-only ledger — the
  // random firm id keeps runs independent.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: firmBroke,
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

const pdfAttachment = (tag: string) => ({
  filename: `${tag}-${SALT}.pdf`,
  contentType: "application/pdf",
  contentBase64: textPdf(tag),
});
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
      { filename, contentType: "application/pdf", contentBase64: textPdf("ghost") },
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

  assert.equal(calls.length, 2, "one extraction per attachment");
  const textCall = calls.find((c) => typeof c.user === "string");
  assert.ok(textCall, "the text PDF travelled as fenced text");
  assert.match(textCall.user as string, /INVOICE main/);
  const visionCall = calls.find((c) => Array.isArray(c.user));
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
