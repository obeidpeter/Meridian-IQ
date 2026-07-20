import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  bankStatementLinesTable,
  bankStatementsTable,
  clerkInferenceCallsTable,
  consentRecordsTable,
  engagementsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  firmsTable,
  outboxTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import statementsRouter from "../../routes/statements.ts";
import type { Principal } from "../auth/rbac.ts";
import { DomainError } from "../errors.ts";
import { CLERK_FLAG_KEY, type CompletionRequest } from "../clerk/gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import { setFlag } from "../flags/flags.ts";
import { ingestStatement } from "./service.ts";
import {
  SCAN_PROPOSAL_FORMAT_KEY,
  proposeStatementLinesFromPdf,
  renderProposedCsv,
} from "./scan-intake.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Scanned bank-statement intake: a PDF statement's lines are PROPOSED by one
// model call (text path for a text-layer PDF, vision path for a scan), the
// proposal is rendered to generic CSV and flows through the ORDINARY
// ingestStatement path — preview rows for human review on commit:false, the
// statement + reconcile outbox on commit:true. Route-side: the exactly-one-of
// csv|pdfBase64 contract, the CORE-03/budget pre-checks (403/429 with no
// provider work, no writes), and the unchanged CSV path.

const SALT = makeRunSalt();

const firmId = randomUUID();
const firmBroke = randomUUID(); // budget-exhaustion firm (ledger is append-only)
const userId = randomUUID();
const clientParty = randomUUID(); // engaged + layer-1 consent
const noConsentParty = randomUUID(); // engaged, NO consent
const brokeParty = randomUUID(); // firmBroke's engaged + consented party

const staff: Principal = {
  userId,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const staffBroke: Principal = { ...staff, firmId: firmBroke };

// Minimal hand-built PDFs (the clerk-scan.test.ts builders): a textless one
// that routes to the vision path, and one whose content stream draws real
// text so getText() finds it and the proposal stays on the text path.
function blankPdf(pages: number, tag: string): string {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const pageObjects = Array.from(
    { length: pages },
    (_, i) =>
      `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj`,
  ).join("\n");
  const pdf = `%PDF-1.4
%${tag}-${SALT}
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj
${pageObjects}
trailer << /Size ${3 + pages} /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

function textPdf(tag: string): string {
  const streamBody = `BT /F1 14 Tf 20 50 Td (STATEMENT ${tag} ${SALT}) Tj ET`;
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

// The canned proposal: two lines, one narration carrying RFC-4180 hazards so
// the render → parse round-trip is exercised.
const proposedLines = [
  {
    valueDate: "2027-03-02",
    narration: `NIP transfer from ZENITH RETAIL ${SALT}`,
    reference: "REF-001",
    amount: "150000.00",
    direction: "credit",
  },
  {
    valueDate: "2027-03-05",
    narration: `POS purchase, "quoted" memo ${SALT}`,
    reference: null,
    amount: "20000.00",
    direction: "debit",
  },
];
const okProposal = () => JSON.stringify({ lines: proposedLines });

const router = statementsRouter as express.Router;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `scan-stmt-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Scan Stmt Firm ${SALT}` },
    { id: firmBroke, name: `Scan Stmt Broke Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Scan Client ${SALT}` },
    { id: noConsentParty, type: "client_business", legalName: `Scan NoConsent ${SALT}` },
    { id: brokeParty, type: "client_business", legalName: `Scan Broke ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `scan A ${SALT}` },
    { firmId, clientPartyId: noConsentParty, type: "retainer", title: `scan B ${SALT}` },
    { firmId: firmBroke, clientPartyId: brokeParty, type: "retainer", title: `scan C ${SALT}` },
  ]);
  await db.insert(consentRecordsTable).values([
    {
      partyId: clientParty,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "contract",
      channel: "test",
    },
    {
      partyId: brokeParty,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "contract",
      channel: "test",
    },
  ]);
  // The reconciliation flag gates every statements route; activate it for the
  // two test firms via overrides without disturbing the global default.
  await db
    .insert(featureFlagsTable)
    .values({ key: "reconciliation", enabled: false, releaseTag: "R2" })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .insert(featureFlagOverridesTable)
    .values([
      { flagKey: "reconciliation", firmId, enabled: true },
      { flagKey: "reconciliation", firmId: firmBroke, enabled: true },
    ])
    .onConflictDoNothing();
  // Spend firmBroke's entire default allowance (2,000,000 tokens) so the pdf
  // branch must 429 before any provider work.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: firmBroke,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `scan-budget-${SALT}`,
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

// ---------------------------------------------------------------------------
// Module: proposal paths and the ordinary ingest round-trip
// ---------------------------------------------------------------------------

test("a text-layer PDF walks the text path; the proposal previews and commits through ingestStatement", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okProposal();
  });
  const proposal = await proposeStatementLinesFromPdf(
    textPdf("text-path"),
    firmId,
    userId,
    gateway,
  );
  assert.equal(proposal.via, "text");
  assert.equal(proposal.pageCount, 0);
  assert.equal(proposal.lines.length, 2);

  assert.equal(calls.length, 1, "one model call proposes the lines");
  const req = calls[0];
  assert.equal(req.purpose, "extract_statement");
  assert.equal(typeof req.user, "string", "text layer travels as fenced text");
  assert.match(req.user as string, /BEGIN STATEMENT/);
  assert.match(req.user as string, new RegExp(`STATEMENT text-path ${SALT}`));

  // Preview (commit:false): the ordinary parse-report rows, nothing persisted.
  const csv = renderProposedCsv(proposal.lines);
  const preview = await ingestStatement({
    firmId,
    clientPartyId: clientParty,
    csv,
    formatKey: SCAN_PROPOSAL_FORMAT_KEY,
    filename: `scan-${SALT}.pdf`,
    commit: false,
    actorId: userId,
  });
  assert.equal(preview.committed, false);
  assert.equal(preview.statementId, null);
  assert.equal(preview.lineCount, 2);
  assert.equal(preview.parsedCount, 2, "every proposed line parses");
  assert.equal(preview.rows[0].valueDate, "2027-03-02");
  assert.equal(preview.rows[0].amount, "150000.00");
  assert.equal(preview.rows[0].direction, "credit");
  assert.equal(
    preview.rows[1].narration,
    `POS purchase, "quoted" memo ${SALT}`,
    "RFC-4180 hazards survive the render/parse round-trip",
  );
  assert.equal(preview.rows[1].direction, "debit");

  // Commit: statement + lines persist, the reconcile outbox job is enqueued.
  const committed = await ingestStatement({
    firmId,
    clientPartyId: clientParty,
    csv,
    formatKey: SCAN_PROPOSAL_FORMAT_KEY,
    filename: `scan-${SALT}.pdf`,
    commit: true,
    actorId: userId,
  });
  assert.equal(committed.committed, true);
  assert.ok(committed.statementId);
  const lines = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, committed.statementId!))
    .orderBy(asc(bankStatementLinesTable.lineNo));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.parseStatus === "parsed"));
  assert.equal(lines[0].amount, "150000.00");
  const [job] = await getDb()
    .select()
    .from(outboxTable)
    .where(
      and(
        eq(outboxTable.type, "statement.reconcile"),
        eq(outboxTable.aggregateId, committed.statementId!),
      ),
    );
  assert.ok(job, "commit enqueued the ordinary reconcile job");

  // Pointer-only provenance audit for the proposal itself.
  const audits = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "statement.scan_extract"),
        eq(auditEventsTable.firmId, firmId),
      ),
    );
  assert.ok(audits.length >= 1);
  assert.equal((audits[0].after as { via?: string }).via, "text");
});

test("a textless PDF walks the vision path with the statement fence", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okProposal();
  });
  const proposal = await proposeStatementLinesFromPdf(
    blankPdf(2, "scan-vision"),
    firmId,
    userId,
    gateway,
  );
  assert.equal(proposal.via, "vision");
  assert.equal(proposal.pageCount, 2);

  const req = calls[0];
  assert.ok(Array.isArray(req.user), "vision content parts");
  const parts = req.user as Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  >;
  const preamble = parts[0];
  assert.ok(
    preamble.type === "text" &&
      /bank statement/i.test(preamble.text) &&
      /2 scanned page images/.test(preamble.text),
    "anti-injection preamble names the scanned statement pages",
  );
  const images = parts.filter((p) => p.type === "image_url");
  assert.equal(images.length, 2, "one image part per rendered page");
});

test("kill switch off: the proposal refuses 503 before decode or provider work", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okProposal();
  });
  await setFlag(CLERK_FLAG_KEY, false);
  try {
    await assert.rejects(
      proposeStatementLinesFromPdf(textPdf("killed"), firmId, userId, gateway),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "CLERK_DISABLED");
        assert.equal(err.status, 503);
        return true;
      },
    );
  } finally {
    await setFlag(CLERK_FLAG_KEY, true);
  }
  assert.equal(providerCalls, 0);
});

test("invalid model output is discarded and fails closed as 502", async () => {
  const gateway = fakeGateway(() => "not json at all");
  await assert.rejects(
    proposeStatementLinesFromPdf(textPdf("invalid-out"), firmId, userId, gateway),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "SCAN_EXTRACT_FAILED");
      assert.equal(err.status, 502);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Route: exactly-one-of contract, pre-checks, unchanged CSV path
// ---------------------------------------------------------------------------

test("POST /statements rejects neither/both of csv|pdfBase64 with 400", async () => {
  const base = await listen(appFor(staff, router));
  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/statements`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const neither = await post({ clientPartyId: clientParty, commit: false });
  assert.equal(neither.status, 400);
  const both = await post({
    clientPartyId: clientParty,
    csv: "Date,Narration,Amount\n2027-01-02,x,100",
    pdfBase64: textPdf("both"),
    commit: false,
  });
  assert.equal(both.status, 400);
});

test("an exhausted firm gets 429 on the pdf branch, before any provider work or writes", async () => {
  const base = await listen(appFor(staffBroke, router));
  const res = await fetch(`${base}/statements`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      clientPartyId: brokeParty,
      pdfBase64: textPdf("broke"),
      commit: true,
    }),
  });
  assert.equal(res.status, 429);
  // Nothing landed: no statement, no extract_statement ledger row, no scan audit.
  const statements = await getDb()
    .select({ id: bankStatementsTable.id })
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.firmId, firmBroke));
  assert.equal(statements.length, 0);
  const ledger = await getDb()
    .select({ id: clerkInferenceCallsTable.id })
    .from(clerkInferenceCallsTable)
    .where(
      and(
        eq(clerkInferenceCallsTable.firmId, firmBroke),
        eq(clerkInferenceCallsTable.purpose, "extract_statement"),
      ),
    );
  assert.equal(ledger.length, 0, "the provider was never touched");
  const audits = await getDb()
    .select({ seq: auditEventsTable.seq })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "statement.scan_extract"),
        eq(auditEventsTable.firmId, firmBroke),
      ),
    );
  assert.equal(audits.length, 0);
});

test("missing layer-1 consent refuses the pdf branch 403 before the model call", async () => {
  // The module tests above ledger extract_statement calls for this firm, so
  // assert on the DELTA: the refused request must add none.
  const ledgerCount = async () =>
    (
      await getDb()
        .select({ id: clerkInferenceCallsTable.id })
        .from(clerkInferenceCallsTable)
        .where(
          and(
            eq(clerkInferenceCallsTable.firmId, firmId),
            eq(clerkInferenceCallsTable.purpose, "extract_statement"),
          ),
        )
    ).length;
  const beforeCount = await ledgerCount();
  const base = await listen(appFor(staff, router));
  const res = await fetch(`${base}/statements`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      clientPartyId: noConsentParty,
      pdfBase64: textPdf("no-consent"),
      commit: false,
    }),
  });
  assert.equal(res.status, 403);
  assert.equal(
    await ledgerCount(),
    beforeCount,
    "no tokens spent for a party without consent",
  );
});

test("the CSV path is unchanged: preview parses without any model involvement", async () => {
  const base = await listen(appFor(staff, router));
  const res = await fetch(`${base}/statements`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      clientPartyId: clientParty,
      csv: `Date,Narration,Reference,Amount,Direction\n2027-04-01,Transfer in ${SALT},R-1,50000.00,CR`,
      commit: false,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    committed: boolean;
    parsedCount: number;
    rows: Array<{ direction: string | null }>;
  };
  assert.equal(body.committed, false);
  assert.equal(body.parsedCount, 1);
  assert.equal(body.rows[0].direction, "credit");
});
