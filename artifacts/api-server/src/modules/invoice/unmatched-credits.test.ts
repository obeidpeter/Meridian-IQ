import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
} from "@workspace/db";
import {
  countFirmUnmatchedCredits,
  listUnmatchedCredits,
} from "./unmatched-credits.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Unmatched-credit detector (round-14 idea #1). Pinned invariants:
//  - only PARSED credit lines with a value date in the window are
//    candidates — debits, invalid lines and old credits never appear;
//  - a live match proposal (proposed OR accepted) explains the line and
//    removes it: the reconciliation screen owns proposed lines, and an
//    accepted match means the money has an invoice;
//  - a rejected/superseded proposal explains nothing — the line stays;
//  - totals come uncapped; rows are capped largest-first;
//  - another client's (and another firm's) statements never bleed in.
// The seeded firm is unique to this test, so its numbers are exact.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const siblingId = randomUUID();
const buyerId = randomUUID();
let matchedLineId: string;
let unmatchedBigId: string;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `UC Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `UC Client ${SALT}` },
    { id: siblingId, type: "client_business", legalName: `UC Sibling ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `UC Buyer ${SALT}` },
  ]);
  const invoiceId = randomUUID();
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyerId,
    invoiceNumber: `UC-${SALT}`,
    issueDate: daysAgo(30),
    status: "settled" as never,
  });

  // RECONCILED: the matcher has run — the only state the detector reads
  // (a still-committed statement's lines are not yet evidence of anything).
  const mkStatement = async (clientPartyId: string, status = "reconciled") => {
    const id = randomUUID();
    await db.insert(bankStatementsTable).values({
      id,
      firmId,
      clientPartyId,
      formatKey: "gtb_csv",
      status: status as never,
    });
    return id;
  };
  const mkLine = async (
    statementId: string,
    no: number,
    opts: {
      amount?: string | null;
      direction?: string;
      valueDate?: string | null;
      parseStatus?: string;
      counterpartyRef?: string;
    },
  ) => {
    const id = randomUUID();
    await db.insert(bankStatementLinesTable).values({
      id,
      statementId,
      lineNo: no,
      valueDate: opts.valueDate === undefined ? daysAgo(5) : opts.valueDate,
      amount: opts.amount === undefined ? "1000.00" : opts.amount,
      direction: (opts.direction ?? "credit") as never,
      counterpartyRef: opts.counterpartyRef ?? `UC-REF-${SALT}`,
      parseStatus: (opts.parseStatus ?? "parsed") as never,
      rawLine: `raw-${no}`,
    });
    return id;
  };

  const stmt = await mkStatement(clientId);
  // Unmatched credits: 5000 (largest) + 1000.
  unmatchedBigId = await mkLine(stmt, 1, { amount: "5000.00" });
  await mkLine(stmt, 2, { amount: "1000.00" });
  // Matched credit (accepted proposal): explained, never appears.
  matchedLineId = await mkLine(stmt, 3, { amount: "700.00" });
  await db.insert(matchProposalsTable).values({
    firmId,
    statementLineId: matchedLineId,
    invoiceId,
    confidence: "0.9500",
    status: "accepted" as never,
  });
  // Proposed match: the reconciliation screen owns it — excluded.
  const proposedLine = await mkLine(stmt, 4, { amount: "600.00" });
  await db.insert(matchProposalsTable).values({
    firmId,
    statementLineId: proposedLine,
    invoiceId,
    confidence: "0.5000",
    status: "proposed" as never,
  });
  // Rejected proposal explains nothing: the line still counts (400).
  const rejectedLine = await mkLine(stmt, 5, { amount: "400.00" });
  await db.insert(matchProposalsTable).values({
    firmId,
    statementLineId: rejectedLine,
    invoiceId,
    confidence: "0.3000",
    status: "rejected" as never,
  });
  // Non-candidates: a debit, an invalid line, an out-of-window credit and a
  // credit with no value date.
  await mkLine(stmt, 6, { direction: "debit", amount: "9000.00" });
  await mkLine(stmt, 7, { parseStatus: "invalid", amount: "9000.00" });
  await mkLine(stmt, 8, { valueDate: daysAgo(120), amount: "9000.00" });
  await mkLine(stmt, 9, { valueDate: null, amount: "9000.00" });

  // A sibling client's unmatched credit: SEC-03 wall.
  const siblingStmt = await mkStatement(siblingId);
  await mkLine(siblingStmt, 1, { amount: "8000.00" });

  // A still-COMMITTED statement (matcher hasn't run): its lines are not yet
  // evidence and must not appear (round-14 review H1 regression).
  const committedStmt = await mkStatement(clientId, "committed");
  await mkLine(committedStmt, 1, { amount: "7777.00" });
});

test("only unexplained, in-window, parsed credits count — largest first", async () => {
  const credits = await listUnmatchedCredits(firmId, clientId);
  assert.equal(credits.count, 3, "5000 + 1000 + rejected-proposal 400");
  assert.equal(credits.totalAmount, "6400.00");
  assert.equal(credits.rows[0].lineId, unmatchedBigId, "largest first");
  assert.equal(credits.rows[0].amount, "5000.00");
  assert.equal(credits.rows[0].counterpartyRef, `UC-REF-${SALT}`);
  assert.equal(credits.truncated, false);
  assert.ok(
    !credits.rows.some((r) => r.lineId === matchedLineId),
    "an accepted match explains the line",
  );
  assert.ok(
    !credits.rows.some((r) => r.amount === "7777.00"),
    "a still-committed statement's lines are not yet evidence",
  );
  assert.match(credits.note, /never an accusation|legitimate reasons/);

  // The sibling's statements are invisible to this client's card.
  const sibling = await listUnmatchedCredits(firmId, siblingId);
  assert.equal(sibling.count, 1);
  assert.equal(sibling.totalAmount, "8000.00");
});

test("the firm-wide digest count shares the same predicate", async () => {
  const firm = await countFirmUnmatchedCredits(firmId);
  assert.equal(firm.credits, 4, "3 for the client + 1 for the sibling");
  assert.equal(firm.clients, 2);

  const otherFirm = await countFirmUnmatchedCredits(randomUUID());
  assert.equal(otherFirm.credits, 0);
  assert.equal(otherFirm.clients, 0);
});
