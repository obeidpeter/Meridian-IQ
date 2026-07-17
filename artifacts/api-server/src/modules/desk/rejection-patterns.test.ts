import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
  errorCatalogueTable,
} from "@workspace/db";
import { computeRejectionPatterns } from "./rejection-patterns.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Rejection-pattern report (round-4 idea #3). Pinned invariants:
//  - only REJECTED attempts count, bucketed into the current window and the
//  equal-length window before it (the trend basis);
//  - distinct invoice and client counts are per current window;
//  - catalogue text rides along when the code is mapped; an unmapped code
//  still reports (as its own row) — that's the catalogue-drafting feedstock;
//  - another firm's rejections never leak in.

const SALT = makeRunSalt();
const CODE = `RP_MAPPED_${SALT.toUpperCase()}`;
const UNMAPPED = `RP_RAW_${SALT.toUpperCase()}`;

const firmA = randomUUID();
const firmB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `RP Firm A ${SALT}` },
    { id: firmB, name: `RP Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA1, type: "client_business", legalName: `RP Client A1 ${SALT}` },
    { id: clientA2, type: "client_business", legalName: `RP Client A2 ${SALT}` },
    { id: clientB, type: "client_business", legalName: `RP Client B ${SALT}` },
    { id: buyer, type: "buyer", legalName: `RP Buyer ${SALT}` },
  ]);
  await db
    .insert(errorCatalogueTable)
    .values({
      code: CODE,
      category: "identity",
      cause: `rp cause ${SALT}`,
      fix: `rp fix ${SALT}`,
      retriable: true,
    })
    .onConflictDoNothing();

  const mkInvoice = async (firmId: string, supplier: string, n: string) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: n,
      issueDate: "2026-07-01",
      status: "failed" as never,
    });
    return id;
  };
  // The table is append-only (guardrail trigger), so the backdate happens at
  // INSERT time rather than via UPDATE.
  const attempt = async (
    invoiceId: string,
    no: number,
    status: string,
    errorCode: string | null,
    agoDays: number,
  ) => {
    await db.insert(submissionAttemptsTable).values({
      invoiceId,
      rail: "rail_primary",
      attemptNo: no,
      idempotencyKey: `rp-${invoiceId}-${no}`,
      status: status as never,
      errorCode,
      createdAt: new Date(Date.now() - agoDays * 86_400_000),
    });
  };

  const invA1a = await mkInvoice(firmA, clientA1, `RP-A1a-${SALT}`);
  const invA1b = await mkInvoice(firmA, clientA1, `RP-A1b-${SALT}`);
  const invA2 = await mkInvoice(firmA, clientA2, `RP-A2-${SALT}`);
  const invB = await mkInvoice(firmB, clientB, `RP-B-${SALT}`);

  // Mapped code: 3 rejections in the current window (2 invoices, 2 clients),
  // 1 in the prior window. The same invoice rejecting twice still counts one
  // DISTINCT invoice.
  await attempt(invA1a, 1, "rejected", CODE, 5);
  await attempt(invA1a, 2, "rejected", CODE, 3);
  await attempt(invA2, 1, "rejected", CODE, 10);
  await attempt(invA1b, 1, "rejected", CODE, 45);
  // Unmapped code: current window only.
  await attempt(invA1b, 2, "rejected", UNMAPPED, 2);
  // Accepted attempts are not rejections.
  await attempt(invA2, 2, "accepted", null, 2);
  // Another firm's rejection with the same code: invisible to firm A.
  await attempt(invB, 1, "rejected", CODE, 4);
  // Ancient rejection (outside both windows): ignored entirely.
  await attempt(invA1a, 3, "rejected", CODE, 90);
});

test("aggregates the firm's own rejections with trend and catalogue grounding", async () => {
  const report = await computeRejectionPatterns(firmA);
  assert.equal(report.windowDays, 30);

  const mapped = report.rows.find((r) => r.errorCode === CODE);
  assert.ok(mapped, "the mapped code reports");
  assert.equal(mapped.count, 3, "current-window rejections");
  assert.equal(mapped.previousCount, 1, "prior-window trend basis");
  assert.equal(mapped.invoiceCount, 2, "distinct invoices, not attempts");
  assert.equal(mapped.clientCount, 2);
  assert.equal(mapped.cause, `rp cause ${SALT}`, "catalogue text rides along");
  assert.equal(mapped.fix, `rp fix ${SALT}`);
  assert.equal(mapped.retriable, true);

  const raw = report.rows.find((r) => r.errorCode === UNMAPPED);
  assert.ok(raw, "an unmapped code still reports");
  assert.equal(raw.count, 1);
  assert.equal(raw.cause, null, "no catalogue entry yet");

  // Totals come from the same SQL pass as the rows (GROUPING SETS), so they
  // are the true firm-window totals, independent of the row cap.
  assert.equal(report.totalRejections, 4, "3 mapped + 1 unmapped in-window");
  assert.equal(report.previousTotal, 1);
});

test("another firm's rejections never leak in", async () => {
  const report = await computeRejectionPatterns(firmB);
  const mapped = report.rows.find((r) => r.errorCode === CODE);
  assert.ok(mapped);
  assert.equal(mapped.count, 1, "only firm B's own rejection");
  assert.equal(mapped.clientCount, 1);
  assert.equal(
    report.rows.find((r) => r.errorCode === UNMAPPED),
    undefined,
    "firm A's unmapped code is invisible",
  );
});
