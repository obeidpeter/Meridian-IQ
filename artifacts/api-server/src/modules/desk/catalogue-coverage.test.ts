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
  operatorCasesTable,
} from "@workspace/db";
import { computeCatalogueCoverage } from "./catalogue-coverage.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Catalogue coverage report (round-13 idea #5). The report is PLATFORM-WIDE
// (the catalogue is global reference data) and the shared test database
// carries attempts from every other suite — so assertions are presence and
// lower bounds, with exact numbers only on the seeded codes themselves.

const SALT = makeRunSalt();
const CODE_UNMAPPED = `CCOV_A_${SALT.toUpperCase()}`;
const CODE_MAPPED_LATE = `CCOV_B_${SALT.toUpperCase()}`;
const CODE_PROACTIVE = `CCOV_C_${SALT.toUpperCase()}`;
const firmId = randomUUID();
const partyId = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `CCOV Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `CCOV Party ${SALT}`,
  });
  const invoiceId = randomUUID();
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: partyId,
    buyerPartyId: partyId,
    invoiceNumber: `CCOV-${SALT}`,
    issueDate: "2026-07-01",
    status: "failed" as never,
  });
  const attempt = async (
    no: number,
    errorCode: string,
    agoDays: number,
  ) => {
    await db.insert(submissionAttemptsTable).values({
      invoiceId,
      rail: "rail_primary",
      attemptNo: no,
      idempotencyKey: `ccov-${invoiceId}-${no}`,
      status: "rejected" as never,
      errorCode,
      createdAt: new Date(Date.now() - agoDays * 86_400_000),
    });
  };

  // A: rejected 3 days ago, never mapped — unmapped debt with a desk case.
  await attempt(1, CODE_UNMAPPED, 3);
  await db.insert(operatorCasesTable).values({
    firmId,
    clientPartyId: partyId,
    invoiceId,
    title: `Unmapped code ${CODE_UNMAPPED}: add a catalogue entry (seen ×1)`,
    errorCode: CODE_UNMAPPED,
    priority: "medium",
    status: "open",
  });
  // B: first seen 2 days ago, mapped NOW — judged, ~2 days to map. Mapping
  // at seed time (not backdated) keeps the entry at the top of the
  // newest-first recentMappings list on the shared test database.
  await attempt(2, CODE_MAPPED_LATE, 2);
  await db.insert(errorCatalogueTable).values({
    code: CODE_MAPPED_LATE,
    category: "mbs",
    cause: `ccov cause ${SALT}`,
    fix: `ccov fix ${SALT}`,
    retriable: false,
  });
  // C: mapped today, never seen on any attempt — proactive, never judged.
  await db.insert(errorCatalogueTable).values({
    code: CODE_PROACTIVE,
    category: "mbs",
    cause: `ccov proactive cause ${SALT}`,
    fix: `ccov proactive fix ${SALT}`,
    retriable: false,
  });
});

test("coverage, unmapped debt and the mapping SLA all see the seeded codes", async () => {
  const report = await computeCatalogueCoverage();

  // Window aggregate (lower bounds on the shared pool): both seeded rejected
  // attempts are coded and in-window, and B's code is mapped today.
  assert.ok(report.rejectedAttempts >= 2);
  assert.ok(report.mappedAttempts >= 1);
  assert.ok(
    report.mappedShare === null ||
      (report.mappedShare >= 0 && report.mappedShare <= 1),
  );
  assert.ok(report.distinctCodes >= 2);
  assert.ok(report.mappedCodes >= 1);

  // The unmapped code reports with its tracking state; the mapped and
  // proactive codes must NOT appear as debt.
  const debt = report.openUnmapped.find((u) => u.code === CODE_UNMAPPED);
  if (debt) {
    // (The list is capped and oldest-first on a shared pool, so the seeded
    // 3-day-old code may fall off; when present its shape must be exact.)
    assert.equal(debt.occurrences, 1);
    assert.equal(debt.openCase, true, "the desk case is seen");
  } else {
    assert.ok(report.unmappedTruncated, "absent only under truncation");
  }
  assert.equal(
    report.openUnmapped.find((u) => u.code === CODE_MAPPED_LATE),
    undefined,
    "a mapped code is not debt",
  );

  // SLA: B was seen before it was mapped (~2 days); C is proactive.
  assert.ok(report.sla.judged >= 1);
  assert.ok(report.sla.proactive >= 1);
  assert.ok(report.sla.avgDaysToMap !== null);
  assert.ok(report.sla.maxDaysToMap !== null);
  const recent = report.recentMappings.find((m) => m.code === CODE_MAPPED_LATE);
  if (recent) {
    assert.ok(
      recent.daysToMap > 1.5 && recent.daysToMap < 2.5,
      `gap ~2 days, got ${recent.daysToMap}`,
    );
    assert.ok(report.sla.maxDaysToMap >= recent.daysToMap);
  } else {
    // The list is capped newest-first on a shared pool: absence is only
    // legitimate when the cap is actually full of newer entries.
    assert.equal(report.recentMappings.length, 10, "absent only when full");
  }
});
