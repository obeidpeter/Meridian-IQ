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
  alertPreferencesTable,
  clerkCasesTable,
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
  MIN_TEXT_CHARS,
  maskInboundPhone,
  processInboundWhatsApp,
  resolveInboundWhatsAppSender,
} from "./whatsapp.ts";

// Inbound WhatsApp intake rail. Pinned invariants (mirroring the email rail):
//  - fail-closed gate: INBOUND_WHATSAPP_TOKEN unset → the rail is dark (404
//    for every request); wrong token → 401;
//  - anti-probe: identical 202 {received} whether or not the sender's phone
//    resolves; unknown AND ambiguous numbers only leave an audit row with a
//    MASKED number (last 4 digits) — ambiguity refuses, never guesses;
//  - a resolved sender's media walks the ordinary capture path stamped with
//    the right firm/creator; a long-enough text-only message walks the TEXT
//    capture path; a short one audit-skips without spending budget;
//  - duplicate redeliveries audit-skip — nothing throws, nothing
//    double-creates.

const SALT = makeRunSalt();
const TOKEN = `wa-secret-${SALT}`;

// Per-run unique phone numbers: the shared DB accumulates alert_preferences
// rows from every run, and a reused number would make this run's matches
// ambiguous. 8 unique digits, distinct prefix per fixture.
const runDigits = `${Date.now()}${process.pid}`.slice(-8);
const PHONE_RESOLVED = `+23470${runDigits}`;
const PHONE_AMBIG = `+23471${runDigits}`;
const PHONE_NO_MEMBER = `+23472${runDigits}`;
const PHONE_CAPPED = `+23473${runDigits}`;
const PHONE_UNKNOWN = `+23474${runDigits}`;
// The resolved party STORES its number in the bare local convention
// (070XXXXXXXX) while the webhook presents it formatted internationally —
// resolution must normalize BOTH sides.
const STORED_RESOLVED = `070${runDigits}`;
const PRESENTED_RESOLVED = `+234 70 ${runDigits.slice(0, 4)}-${runDigits.slice(4)}`;

const firm1 = randomUUID();
const firmCapped = randomUUID();
const partyResolved = randomUUID();
const partyAmbA = randomUUID();
const partyAmbB = randomUUID();
const partyNoMember = randomUUID();
const partyCapped = randomUUID();
const clientUserId = randomUUID();
const cappedUserId = randomUUID();

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

// A one-page PDF whose content stream draws real text (the email-rail test
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

const PNG_B64 = Buffer.from(`wa-png-bytes-${SALT}`).toString("base64");

const LONG_TEXT = `Please raise an invoice to Acme Distribution Ltd for the July retainer, 150000 naira plus VAT ${SALT}`;

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

async function ignoredAudits() {
  return getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "inbound.whatsapp.ignored"))
    .orderBy(desc(auditEventsTable.seq))
    .limit(20);
}

const savedToken = process.env.INBOUND_WHATSAPP_TOKEN;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firm1, name: `WA Firm ${SALT}` },
    { id: firmCapped, name: `WA Capped Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: partyResolved, type: "client_business", legalName: `WA Client ${SALT}` },
    { id: partyAmbA, type: "client_business", legalName: `WA Amb A ${SALT}` },
    { id: partyAmbB, type: "client_business", legalName: `WA Amb B ${SALT}` },
    { id: partyNoMember, type: "client_business", legalName: `WA Orphan ${SALT}` },
    { id: partyCapped, type: "client_business", legalName: `WA Capped ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: clientUserId, email: `wa-client-${SALT}@inbound-test.local` },
    { id: cappedUserId, email: `wa-capped-${SALT}@inbound-test.local` },
  ]);
  await db.insert(membershipsTable).values([
    {
      userId: clientUserId,
      firmId: firm1,
      role: "client_user",
      clientPartyId: partyResolved,
    },
    {
      userId: cappedUserId,
      firmId: firmCapped,
      role: "client_user",
      clientPartyId: partyCapped,
    },
  ]);
  // Stored numbers are free text: the resolved party keeps the bare local
  // convention, one ambiguous party stores whatsappTo and its twin stores the
  // same number under phone — either field matching counts, and two parties
  // sharing a number must refuse.
  await db.insert(alertPreferencesTable).values([
    { clientPartyId: partyResolved, whatsappTo: STORED_RESOLVED },
    { clientPartyId: partyAmbA, whatsappTo: `071${runDigits}` },
    { clientPartyId: partyAmbB, phone: PHONE_AMBIG },
    { clientPartyId: partyNoMember, phone: PHONE_NO_MEMBER },
    { clientPartyId: partyCapped, whatsappTo: PHONE_CAPPED },
  ]);
});

after(async () => {
  if (savedToken === undefined) delete process.env.INBOUND_WHATSAPP_TOKEN;
  else process.env.INBOUND_WHATSAPP_TOKEN = savedToken;
  await restoreClerkFlag();
  await closeAllServers();
});

const pdfAttachment = (tag: string) => ({
  filename: `${tag}-${SALT}.pdf`,
  contentType: "application/pdf",
  contentBase64: textPdf(tag),
});

test("phone masking keeps the last 4 digits only", () => {
  assert.equal(maskInboundPhone("+2348031234567"), "***4567");
  assert.equal(maskInboundPhone("0803 123 4567"), "***4567");
  assert.equal(maskInboundPhone("+12"), "***12");
});

test("token unset: the rail is dark — 404 even for a well-formed request", async () => {
  delete process.env.INBOUND_WHATSAPP_TOKEN;
  const base = await listen(inboundApp());
  const res = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": TOKEN },
    body: JSON.stringify({ sender: PRESENTED_RESOLVED, attachments: [pdfAttachment("dark")] }),
  });
  assert.equal(res.status, 404);
});

test("wrong or missing token: 401; malformed body: 400", async () => {
  process.env.INBOUND_WHATSAPP_TOKEN = TOKEN;
  const base = await listen(inboundApp());
  const wrong = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": "nope" },
    body: JSON.stringify({ sender: PRESENTED_RESOLVED, attachments: [pdfAttachment("bad")] }),
  });
  assert.equal(wrong.status, 401);
  const missing = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sender: PRESENTED_RESOLVED, attachments: [pdfAttachment("bad")] }),
  });
  assert.equal(missing.status, 401);
  // No media AND no text is a shape error, not anti-probe territory.
  const empty = await fetch(`${base}/api/inbound/whatsapp?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sender: PRESENTED_RESOLVED }),
  });
  assert.equal(empty.status, 400);
});

test("unknown and ambiguous numbers: 202 identical to success, zero cases, masked audit", async () => {
  process.env.INBOUND_WHATSAPP_TOKEN = TOKEN;
  const base = await listen(inboundApp());

  // Unknown number, text-only (short — the detached pipeline needs no
  // provider either way, since resolution refuses first).
  const unknownRes = await fetch(`${base}/api/inbound/whatsapp?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sender: PHONE_UNKNOWN, text: "hello" }),
  });
  assert.equal(unknownRes.status, 202);
  const unknownBody = await unknownRes.json();
  assert.deepEqual(unknownBody, { received: 1 });

  // ANTI-PROBE: a resolved sender's response is byte-for-byte the same shape.
  const resolvedRes = await fetch(`${base}/api/inbound/whatsapp?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      sender: PRESENTED_RESOLVED,
      // Unsupported type: the detached pipeline audit-skips it, so this
      // route call needs no model provider.
      attachments: [
        { filename: `probe-${SALT}.csv`, contentType: "text/csv", contentBase64: PNG_B64 },
      ],
    }),
  });
  assert.equal(resolvedRes.status, 202);
  assert.deepEqual(await resolvedRes.json(), unknownBody);

  const unknownAudit = await eventually(async () => {
    const rows = await ignoredAudits();
    return rows.find(
      (r) =>
        (r.after as { sender?: string })?.sender === `***${runDigits.slice(-4)}` &&
        (r.after as { reason?: string })?.reason === "no_match",
    );
  }, "unknown-number ignored audit row");
  assert.equal((unknownAudit.after as { hasText?: boolean }).hasText, true);
  assert.equal((unknownAudit.after as { attachments?: number }).attachments, 0);

  // Ambiguous: two client parties share the number — refuse, never guess.
  const ambiguous = await processInboundWhatsApp({
    sender: PHONE_AMBIG,
    text: LONG_TEXT,
    attachments: [],
  });
  assert.deepEqual(ambiguous, { resolved: false, caseIds: [], skipped: [] });
  const ambiguousAudit = (await ignoredAudits()).find(
    (r) => (r.after as { reason?: string })?.reason === "ambiguous",
  );
  assert.ok(ambiguousAudit, "ambiguous drop is durable");

  // A number whose party has no client_user membership refuses too.
  const orphan = await processInboundWhatsApp({
    sender: PHONE_NO_MEMBER,
    text: LONG_TEXT,
    attachments: [],
  });
  assert.equal(orphan.resolved, false);

  // An unparseable "phone" is refused before any lookup.
  const junk = await processInboundWhatsApp({
    sender: "not-a-phone",
    text: LONG_TEXT,
    attachments: [],
  });
  assert.equal(junk.resolved, false);
  const junkAudit = (await ignoredAudits()).find(
    (r) => (r.after as { reason?: string })?.reason === "invalid_phone",
  );
  assert.ok(junkAudit);

  // Nothing was created for any of them.
  const cases = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.sourceName, `probe-${SALT}.csv`));
  assert.equal(cases.length, 0);
});

test("sender resolution normalizes BOTH sides of the comparison", async () => {
  // Presented internationally with human formatting; stored as bare local.
  const resolved = await resolveInboundWhatsAppSender(PRESENTED_RESOLVED);
  assert.deepEqual(resolved, {
    ok: true,
    resolved: {
      userId: clientUserId,
      firmId: firm1,
      clientPartyId: partyResolved,
    },
  });
  // The exact stored form and the canonical form resolve identically.
  assert.deepEqual(await resolveInboundWhatsAppSender(STORED_RESOLVED), resolved);
  assert.deepEqual(await resolveInboundWhatsAppSender(PHONE_RESOLVED), resolved);
  assert.deepEqual(await resolveInboundWhatsAppSender(PHONE_UNKNOWN), {
    ok: false,
    reason: "no_match",
  });
  assert.deepEqual(await resolveInboundWhatsAppSender(PHONE_AMBIG), {
    ok: false,
    reason: "ambiguous",
  });
  assert.deepEqual(await resolveInboundWhatsAppSender(PHONE_NO_MEMBER), {
    ok: false,
    reason: "no_membership",
  });
  assert.deepEqual(await resolveInboundWhatsAppSender("abc"), {
    ok: false,
    reason: "invalid_phone",
  });
});

test("resolved sender: media walks the capture path stamped for the client; redelivery absorbed", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okExtraction();
  });
  const input = {
    sender: PRESENTED_RESOLVED,
    text: "see attached", // caption alongside media is ignored
    attachments: [
      pdfAttachment("wamain"),
      // No filename: WhatsApp media often has none — the rail defaults one.
      { contentType: "image/png", contentBase64: PNG_B64 },
    ],
  };
  const result = await processInboundWhatsApp(input, gateway);
  assert.equal(result.resolved, true);
  assert.equal(result.caseIds.length, 2);
  assert.deepEqual(result.skipped, []);
  assert.equal(calls.length, 2, "one extraction per attachment");

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
  assert.equal(pdfRow.sourceName, `wamain-${SALT}.pdf`);
  const pngRow = rows.find((r) => r.sourceType === "image");
  assert.ok(pngRow);
  assert.equal(pngRow.sourceName, "whatsapp-media-2.png", "defaulted filename");

  // Pointer-only receipt names both cases, sender masked even when resolved.
  const receipt = await eventually(async () => {
    const receipts = await getDb()
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.action, "inbound.whatsapp.received"))
      .orderBy(desc(auditEventsTable.seq))
      .limit(20);
    return receipts.find((r) =>
      result.caseIds.every((id) =>
        ((r.after as { caseIds?: string[] })?.caseIds ?? []).includes(id),
      ),
    );
  }, "received audit row");
  assert.equal(receipt.actorId, clientUserId);
  assert.equal(receipt.firmId, firm1);
  assert.equal(
    (receipt.after as { sender?: string }).sender,
    `***${runDigits.slice(-4)}`,
  );

  // BSP redelivery of the SAME message: the duplicate guard audit-skips both
  // attachments and creates no second case.
  const redelivered = await processInboundWhatsApp(input, gateway);
  assert.equal(redelivered.resolved, true);
  assert.deepEqual(redelivered.caseIds, []);
  assert.deepEqual(
    redelivered.skipped.map((s) => s.reason),
    ["DUPLICATE_SOURCE", "DUPLICATE_SOURCE"],
  );
  const again = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.sourceName, `wamain-${SALT}.pdf`));
  assert.equal(again.length, 1, "still exactly one case per attachment");
});

test("text-only messages: long enough walks the text path, short audit-skips without spending", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okExtraction();
  });

  // Short text ("thanks"): no model call, durable skip.
  const short = await processInboundWhatsApp(
    { sender: PRESENTED_RESOLVED, text: "thanks!", attachments: [] },
    gateway,
  );
  assert.equal(short.resolved, true);
  assert.deepEqual(short.caseIds, []);
  assert.deepEqual(short.skipped, [
    { filename: "whatsapp-message", reason: "TEXT_TOO_SHORT" },
  ]);
  assert.equal(providerCalls, 0, "a greeting never touches the provider");
  assert.ok(LONG_TEXT.length >= MIN_TEXT_CHARS, "fixture sanity");

  // Long text: the ordinary TEXT capture path, stamped for the client.
  const long = await processInboundWhatsApp(
    { sender: PRESENTED_RESOLVED, text: LONG_TEXT, attachments: [] },
    gateway,
  );
  assert.equal(long.resolved, true);
  assert.equal(long.caseIds.length, 1);
  assert.deepEqual(long.skipped, []);
  assert.equal(providerCalls, 1);
  const [row] = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, long.caseIds[0]));
  assert.equal(row.sourceType, "text");
  assert.equal(row.sourceText, LONG_TEXT);
  assert.equal(row.firmId, firm1);
  assert.equal(row.createdBy, clientUserId);
});

test("daily cap: over-cap items audit-skip, counted from this rail's own receipts", async () => {
  const savedCap = process.env.INBOUND_WHATSAPP_DAILY_CAP;
  process.env.INBOUND_WHATSAPP_DAILY_CAP = "2";
  try {
    const csv = (tag: string) => ({
      filename: `${tag}-${SALT}.csv`,
      contentType: "text/csv",
      contentBase64: PNG_B64,
    });
    // Fresh firm, cap 2, three attachments: the first two consume the day's
    // allowance (then skip as unsupported — no provider needed), the third
    // is refused by the cap itself.
    const first = await processInboundWhatsApp({
      sender: PHONE_CAPPED,
      attachments: [csv("wcap-a"), csv("wcap-b"), csv("wcap-c")],
    });
    assert.equal(first.resolved, true);
    assert.deepEqual(
      first.skipped.map((s) => s.reason),
      ["UNSUPPORTED_TYPE", "UNSUPPORTED_TYPE", "INBOUND_DAILY_CAP"],
    );
    // The first receipt (3 items) now exceeds the cap, so even a text-only
    // message is refused — the count comes from the audit trail, not
    // process memory.
    const second = await processInboundWhatsApp({
      sender: PHONE_CAPPED,
      text: LONG_TEXT,
      attachments: [],
    });
    assert.equal(second.resolved, true);
    assert.deepEqual(
      second.skipped.map((s) => s.reason),
      ["INBOUND_DAILY_CAP"],
    );
  } finally {
    if (savedCap === undefined) delete process.env.INBOUND_WHATSAPP_DAILY_CAP;
    else process.env.INBOUND_WHATSAPP_DAILY_CAP = savedCap;
  }
});
