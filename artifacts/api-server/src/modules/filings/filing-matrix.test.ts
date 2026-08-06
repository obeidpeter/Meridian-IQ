import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  filingReturnsTable,
  firmsTable,
  partiesTable,
} from "@workspace/db";
import filingMatrixRouter from "../../routes/filing-matrix.ts";
import { computeFilingMatrix } from "./filing-matrix.ts";
import { filingDueDate, previousLagosPeriod } from "./statutory-calendar.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The filing matrix (Filing Desk Phase 3): one row per actively-served
// client with the current period's VAT/PAYE statuses side by side. Pinned:
//  - the period, label and due dates come from the statutory calendar;
//  - a client without a minted row shows null (the sync button's case) and
//    counts in NO total — unfiled totals stay the register's;
//  - overdue counts unfiled cells strictly past their due date, on the
//    register's own `due_date < today` boundary;
//  - archived-only clients drop off; a foreign firm reads empty;
//  - the route carries the /console/vat-positions posture (firmScope).
// Frozen far-future clocks keep every assertion exact whatever today is —
// and keep the fixture period clear of anything the mint sweep creates.

const SALT = makeRunSalt();

const firmId = randomUUID();
const emptyFirmId = randomUUID();
const routeFirmId = randomUUID();
const alphaParty = randomUUID(); // "MX Alpha A ..." — sorts first
const zuluParty = randomUUID(); // "MX Zulu Z ..." — sorts last
const archivedParty = randomUUID(); // archived-only — never a row
const routeParty = randomUUID();

// Mid-period instant: period 2098-07; VAT due 2098-08-21 and PAYE due
// 2098-08-10 are both still ahead of Lagos-today 2098-08-05.
const EARLY = new Date("2098-08-05T12:00:00Z");
// Same period, past both due dates: every unfiled cell is overdue.
const LATE = new Date("2098-08-25T12:00:00Z");
const PERIOD = previousLagosPeriod(EARLY); // 2098-07

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Matrix Firm ${SALT}` },
    { id: emptyFirmId, name: `Matrix Empty Firm ${SALT}` },
    { id: routeFirmId, name: `Matrix Route Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: alphaParty, type: "client_business", legalName: `MX Alpha A ${SALT}` },
    { id: zuluParty, type: "client_business", legalName: `MX Zulu Z ${SALT}` },
    {
      id: archivedParty,
      type: "client_business",
      legalName: `MX Archived ${SALT}`,
    },
    { id: routeParty, type: "client_business", legalName: `MX Route ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId,
      clientPartyId: alphaParty,
      type: "retainer" as const,
      status: "open" as const,
      title: `mx alpha ${SALT}`,
    },
    {
      firmId,
      clientPartyId: zuluParty,
      type: "retainer" as const,
      status: "in_progress" as const,
      title: `mx zulu ${SALT}`,
    },
    {
      firmId,
      clientPartyId: archivedParty,
      type: "retainer" as const,
      status: "archived" as const,
      title: `mx archived ${SALT}`,
    },
    {
      firmId: routeFirmId,
      clientPartyId: routeParty,
      type: "retainer" as const,
      status: "open" as const,
      title: `mx route ${SALT}`,
    },
  ]);
  // The register cells: alpha filed VAT / upcoming PAYE; zulu prepared VAT
  // and NO PAYE row (the null cell). Due dates as the mint would store them.
  const seed = (
    clientPartyId: string,
    taxType: "vat" | "paye",
    status: "upcoming" | "prepared" | "filed",
  ) => ({
    firmId,
    clientPartyId,
    taxType,
    period: PERIOD,
    dueDate: filingDueDate(PERIOD, taxType),
    status,
  });
  await db.insert(filingReturnsTable).values([
    seed(alphaParty, "vat", "filed"),
    seed(alphaParty, "paye", "upcoming"),
    seed(zuluParty, "vat", "prepared"),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("rows, nulls and calendar facts: one row per live client, name-ordered", async () => {
  const matrix = await computeFilingMatrix(firmId, EARLY);
  assert.equal(matrix.period, PERIOD);
  assert.equal(matrix.periodLabel, "July 2098");
  assert.deepEqual(matrix.dueDates, { vat: "2098-08-21", paye: "2098-08-10" });

  assert.deepEqual(matrix.rows, [
    {
      clientPartyId: alphaParty,
      clientName: `MX Alpha A ${SALT}`,
      vat: "filed",
      paye: "upcoming",
    },
    {
      clientPartyId: zuluParty,
      clientName: `MX Zulu Z ${SALT}`,
      vat: "prepared",
      paye: null,
    },
  ]);
  assert.ok(
    matrix.rows.every((r) => r.clientPartyId !== archivedParty),
    "an archived-only client holds no row",
  );
});

test("totals: filed/unfiled count minted cells; overdue flips past the statutory date", async () => {
  const early = await computeFilingMatrix(firmId, EARLY);
  // 3 minted cells: 1 filed, 2 unfiled (upcoming + prepared — prepared still
  // owes the authority a return); the null cell counts nowhere. Nothing is
  // overdue while both due dates are ahead.
  assert.deepEqual(early.totals, {
    clients: 2,
    filed: 1,
    unfiled: 2,
    overdue: 0,
  });

  const late = await computeFilingMatrix(firmId, LATE);
  assert.deepEqual(late.totals, { clients: 2, filed: 1, unfiled: 2, overdue: 2 });
});

test("a foreign firm reads empty — rows and totals alike", async () => {
  const matrix = await computeFilingMatrix(emptyFirmId, EARLY);
  assert.deepEqual(matrix.rows, []);
  assert.deepEqual(matrix.totals, {
    clients: 0,
    filed: 0,
    unfiled: 0,
    overdue: 0,
  });
  // The calendar facts still answer — the cockpit header renders either way.
  assert.equal(matrix.period, PERIOD);
});

test("the route serves the caller's firm under the console rollup posture", async () => {
  const base = await listen(
    appFor(firmPrincipal(routeFirmId), filingMatrixRouter),
  );
  const res = await fetch(`${base}/console/filing-matrix`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    period: string;
    rows: { clientPartyId: string; vat: null; paye: null }[];
    totals: { clients: number; filed: number; unfiled: number; overdue: number };
  };
  // The LIVE period (the route takes no clock): shape-pinned, not value-
  // pinned. The route firm's client has no minted rows, so both cells are
  // null and no filing total moves — deterministic whatever today is.
  assert.match(body.period, /^\d{4}-\d{2}$/);
  assert.deepEqual(body.rows, [
    {
      clientPartyId: routeParty,
      clientName: `MX Route ${SALT}`,
      vat: null,
      paye: null,
    },
  ]);
  assert.deepEqual(body.totals, {
    clients: 1,
    filed: 0,
    unfiled: 0,
    overdue: 0,
  });
});
