import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  usersTable,
  membershipsTable,
  alertPreferencesTable,
  clerkCasesTable,
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
  runPhoneDigits,
  seedInboundClient,
  testPhone,
  withEnv,
} from "./test-support.ts";
import {
  MIN_TEXT_CHARS,
  maskInboundPhone,
  processInboundWhatsApp,
  resolveInboundWhatsAppSender,
} from "./whatsapp.ts";
import { drain } from "../pipeline/pipeline.ts";

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

// Per-run unique phone numbers via the shared generator (test-support.ts):
// the shared DB accumulates alert_preferences rows from every run, and a
// reused number would make this run's matches ambiguous. This file claims
// prefixes 70–75 in the testPhone registry.
const PHONE_RESOLVED = testPhone(70);
const PHONE_AMBIG = testPhone(71);
const PHONE_NO_MEMBER = testPhone(72);
const PHONE_CAPPED = testPhone(73);
const PHONE_UNKNOWN = testPhone(74);
const PHONE_STAFF_SET = testPhone(75);
// The resolved party STORES its number in the bare local convention
// (070XXXXXXXX) while the webhook presents it formatted internationally —
// resolution must normalize BOTH sides.
const STORED_RESOLVED = `070${runPhoneDigits}`;
const PRESENTED_RESOLVED = `+234 70 ${runPhoneDigits.slice(0, 4)}-${runPhoneDigits.slice(4)}`;

// Fixture ids minted by seedInboundClient in before(); only the ones the
// tests themselves assert on live at module scope.
let firm1: string;
let partyResolved: string;
let clientUserId: string;

const PNG_B64 = Buffer.from(`wa-png-bytes-${SALT}`).toString("base64");

const LONG_TEXT = `Please raise an invoice to Acme Distribution Ltd for the July retainer, 150000 naira plus VAT ${SALT}`;

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
  // The resolved and capped clients ride the shared seeder (test-support.ts).
  // The resolved party STORES its number in the bare local convention — see
  // the STORED_RESOLVED comment above.
  ({
    firmId: firm1,
    partyId: partyResolved,
    userId: clientUserId,
  } = await seedInboundClient(db, {
    firmName: `WA Firm ${SALT}`,
    partyName: `WA Client ${SALT}`,
    email: `wa-client-${SALT}@inbound-test.local`,
    whatsapp: { number: STORED_RESOLVED, setByRole: "client_user" },
  }));
  await seedInboundClient(db, {
    firmName: `WA Capped Firm ${SALT}`,
    partyName: `WA Capped ${SALT}`,
    email: `wa-capped-${SALT}@inbound-test.local`,
    whatsapp: { number: PHONE_CAPPED, setByRole: "client_user" },
  });
  // The remaining fixtures stay inline — the seeder cannot express them:
  // party-only rows (no user/membership), a shared number across two
  // parties, and a staff-set number whose membership binds into the SAME
  // firm as the resolved client.
  const partyAmbA = randomUUID();
  const partyAmbB = randomUUID();
  const partyNoMember = randomUUID();
  const partyStaffSet = randomUUID();
  const staffSetUserId = randomUUID();
  await db.insert(partiesTable).values([
    { id: partyAmbA, type: "client_business", legalName: `WA Amb A ${SALT}` },
    { id: partyAmbB, type: "client_business", legalName: `WA Amb B ${SALT}` },
    {
      id: partyNoMember,
      type: "client_business",
      legalName: `WA Orphan ${SALT}`,
    },
    {
      id: partyStaffSet,
      type: "client_business",
      legalName: `WA StaffSet ${SALT}`,
    },
  ]);
  await db
    .insert(usersTable)
    .values([
      { id: staffSetUserId, email: `wa-staffset-${SALT}@inbound-test.local` },
    ]);
  await db.insert(membershipsTable).values([
    {
      userId: staffSetUserId,
      firmId: firm1,
      role: "client_user",
      clientPartyId: partyStaffSet,
    },
  ]);
  // Stored numbers are free text: one ambiguous party stores whatsappTo and
  // its twin stores the same number under phone — either field matching
  // counts, and two parties sharing a number must refuse. Provenance gate:
  // only rows whose contact fields the CLIENT set themselves
  // (contact_set_by_role='client_user') are routing keys — the staff-set
  // fixture and any legacy null-provenance row must refuse even with an
  // otherwise-perfect match.
  await db.insert(alertPreferencesTable).values([
    {
      clientPartyId: partyAmbA,
      whatsappTo: `071${runPhoneDigits}`,
      contactSetByRole: "client_user",
    },
    {
      clientPartyId: partyAmbB,
      phone: PHONE_AMBIG,
      contactSetByRole: "client_user",
    },
    {
      clientPartyId: partyNoMember,
      phone: PHONE_NO_MEMBER,
      contactSetByRole: "client_user",
    },
    // Staff typed this number in for the client: never a routing key.
    {
      clientPartyId: partyStaffSet,
      whatsappTo: PHONE_STAFF_SET,
      contactSetByRole: "firm_staff",
    },
  ]);
});

after(async () => {
  if (savedToken === undefined) delete process.env.INBOUND_WHATSAPP_TOKEN;
  else process.env.INBOUND_WHATSAPP_TOKEN = savedToken;
  await restoreClerkFlag();
  await closeAllServers();
});

const pdfAttachment = makePdfAttachment(SALT);

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
    body: JSON.stringify({
      sender: PRESENTED_RESOLVED,
      attachments: [pdfAttachment("dark")],
    }),
  });
  assert.equal(res.status, 404);
});

test("wrong or missing token: 401; malformed body: 400", async () => {
  process.env.INBOUND_WHATSAPP_TOKEN = TOKEN;
  const base = await listen(inboundApp());
  const wrong = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": "nope" },
    body: JSON.stringify({
      sender: PRESENTED_RESOLVED,
      attachments: [pdfAttachment("bad")],
    }),
  });
  assert.equal(wrong.status, 401);
  const missing = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      sender: PRESENTED_RESOLVED,
      attachments: [pdfAttachment("bad")],
    }),
  });
  assert.equal(missing.status, 401);
  // No media AND no text is a shape error, not anti-probe territory.
  const empty = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": TOKEN },
    body: JSON.stringify({ sender: PRESENTED_RESOLVED }),
  });
  assert.equal(empty.status, 400);
  const viaQuery = await fetch(`${base}/api/inbound/whatsapp?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sender: PHONE_UNKNOWN, text: "hello" }),
  });
  assert.equal(viaQuery.status, 401, "secrets in URLs are never accepted");
});

test("unknown and ambiguous numbers: 202 identical to success, zero cases, masked audit", async () => {
  process.env.INBOUND_WHATSAPP_TOKEN = TOKEN;
  const base = await listen(inboundApp());

  // Unknown number, text-only (short — the queued pipeline needs no
  // provider either way, since resolution refuses first).
  const unknownRes = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": TOKEN },
    body: JSON.stringify({ sender: PHONE_UNKNOWN, text: "hello" }),
  });
  assert.equal(unknownRes.status, 202);
  const unknownBody = await unknownRes.json();
  assert.deepEqual(unknownBody, { received: 1 });

  // ANTI-PROBE: a resolved sender's response is byte-for-byte the same shape.
  const resolvedRes = await fetch(`${base}/api/inbound/whatsapp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-op-token": TOKEN },
    body: JSON.stringify({
      sender: PRESENTED_RESOLVED,
      // Unsupported type: the queued pipeline audit-skips it, so this
      // route call needs no model provider.
      attachments: [
        {
          filename: `probe-${SALT}.csv`,
          contentType: "text/csv",
          contentBase64: PNG_B64,
        },
      ],
    }),
  });
  assert.equal(resolvedRes.status, 202);
  assert.deepEqual(await resolvedRes.json(), unknownBody);
  await drain();

  const unknownAudit = await eventually(async () => {
    const rows = await ignoredAudits();
    return rows.find(
      (r) =>
        (r.after as { sender?: string })?.sender ===
          `***${runPhoneDigits.slice(-4)}` &&
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
  assert.deepEqual(
    await resolveInboundWhatsAppSender(STORED_RESOLVED),
    resolved,
  );
  assert.deepEqual(
    await resolveInboundWhatsAppSender(PHONE_RESOLVED),
    resolved,
  );
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

test("a staff-set number is never a routing key (contact provenance)", async () => {
  // The row matches perfectly — party, membership, normalized number — but
  // the number was typed in by firm staff (contact_set_by_role='firm_staff'),
  // so resolution must refuse: a staff-writable free-text field must not be
  // able to route documents into a client's book. Legacy rows with NULL
  // provenance fail closed the same way (the eq() filter excludes null).
  assert.deepEqual(await resolveInboundWhatsAppSender(PHONE_STAFF_SET), {
    ok: false,
    reason: "no_match",
  });
  const dropped = await processInboundWhatsApp({
    sender: PHONE_STAFF_SET,
    text: LONG_TEXT,
    attachments: [],
  });
  assert.deepEqual(dropped, { resolved: false, caseIds: [], skipped: [] });
});

test("resolved sender: media walks the capture path stamped for the client; redelivery absorbed", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okExtraction();
  });
  const input = {
    sender: PRESENTED_RESOLVED,
    text: "see attached", // caption: a triage signal, never captured itself
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
  // Each media item makes one triage call (whose okExtraction() answer fails
  // the triage schema and falls back to the invoice lane — triage.test.ts
  // covers the lane switch) and one extraction call.
  assert.equal(
    calls.filter((c) => c.schemaName === "invoice_extraction").length,
    2,
    "one extraction per attachment",
  );
  assert.equal(
    calls.filter((c) => c.schemaName === "document_triage").length,
    2,
    "one triage call per attachment",
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
    `***${runPhoneDigits.slice(-4)}`,
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
  await withEnv("INBOUND_WHATSAPP_DAILY_CAP", "2", async () => {
    const csv = makeCsvAttachment(SALT, PNG_B64);
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
    // process memory. Deliberately NOT the email rail's second send: this
    // pins that text-only messages are cap-refused too.
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
  });
});
