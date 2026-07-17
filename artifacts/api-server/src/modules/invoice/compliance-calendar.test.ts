import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable, partiesTable, invoicesTable } from "@workspace/db";
import { computeComplianceCalendar } from "./compliance-calendar.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Firm-level compliance calendar (round-6 idea #5). Pinned invariants:
//  - the submit-by date is issue_date + SUBMISSION_WINDOW_DAYS, the same
//  expression the dashboard and reminder sweep use — due today or earlier is
//  ALREADY overdue (the statutory instant is Lagos midnight at day start);
//  - only unsubmitted (draft/validated) invoices produce events; the horizon
//  bounds the days; the overdue backlog counts distinct clients exactly;
//  - the current month's VAT 21st appears while still ahead;
//  - another firm's book never leaks in.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA = randomUUID();
const buyer = randomUUID();

// Fixed "now" so every date assertion is deterministic: 2026-07-10 Lagos.
const NOW = new Date("2026-07-10T12:00:00Z");

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Cal Firm A ${SALT}` },
    { id: firmB, name: `Cal Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `Cal Client ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Cal Buyer ${SALT}` },
  ]);
  const mk = (
    firmId: string,
    n: string,
    issueDate: string,
    status = "draft",
    kind = "invoice",
  ) => ({
    id: randomUUID(),
    firmId,
    supplierPartyId: clientA,
    buyerPartyId: buyer,
    invoiceNumber: n,
    issueDate,
    status: status as never,
    kind: kind as never,
  });
  await db.insert(invoicesTable).values([
    // Overdue: due 2026-06-27 and 2026-07-10 (due today = already overdue).
    mk(firmA, `CAL-o1-${SALT}`, "2026-06-20"),
    mk(firmA, `CAL-o2-${SALT}`, "2026-07-03"),
    // Upcoming: due 2026-07-15, inside the horizon.
    mk(firmA, `CAL-u1-${SALT}`, "2026-07-08"),
    mk(firmA, `CAL-u2-${SALT}`, "2026-07-08", "validated"),
    // An unsubmitted credit note faces the same window (the dashboard, risk
    // list and reminder sweep all count it — so must the calendar).
    mk(firmA, `CAL-cn-${SALT}`, "2026-07-08", "draft", "credit_note"),
    // Beyond the 35-day horizon: due 2026-08-27.
    mk(firmA, `CAL-far-${SALT}`, "2026-08-20"),
    // Submitted paper produces no calendar event.
    mk(firmA, `CAL-s-${SALT}`, "2026-07-08", "submitted"),
    // Firm B's book is invisible to firm A.
    mk(firmB, `CAL-b-${SALT}`, "2026-07-08"),
  ]);
});

test("aggregates the firm's statutory dates on the Lagos calendar", async () => {
  const cal = await computeComplianceCalendar(firmA, NOW);
  assert.equal(cal.horizonDays, 35);

  assert.equal(cal.overdue.invoices, 2, "due-today counts as overdue");
  assert.equal(cal.overdue.clients, 1, "distinct clients, not per-day sums");

  const submitDay = cal.days.find((d) => d.date === "2026-07-15");
  assert.ok(submitDay, "the upcoming submission day appears");
  const submitEvent = submitDay.events.find(
    (e) => e.kind === "invoice_submission",
  );
  assert.equal(
    submitEvent?.invoices,
    3,
    "draft + validated + unsubmitted credit note all count",
  );
  assert.equal(submitEvent?.clients, 1);

  // This month's VAT 21st is still ahead of the fixed now — it must appear
  // (the return for June's period), plus nothing beyond the horizon.
  const vatDay = cal.days.find((d) =>
    d.events.some((e) => e.kind === "vat_return"),
  );
  assert.equal(vatDay?.date, "2026-07-21");
  assert.equal(
    cal.days.some((d) => d.date >= "2026-08-27"),
    false,
    "beyond-horizon submission days are excluded",
  );
});

test("another firm's calendar is empty of firm A's book", async () => {
  const cal = await computeComplianceCalendar(firmB, NOW);
  assert.equal(cal.overdue.invoices, 0);
  const submitEvents = cal.days.flatMap((d) =>
    d.events.filter((e) => e.kind === "invoice_submission"),
  );
  assert.equal(
    submitEvents.reduce((s, e) => s + (e.invoices ?? 0), 0),
    1,
    "only firm B's own invoice",
  );
});
