import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  invoicesTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import {
  advanceRunDate,
  createTemplate,
  setTemplateActive,
  sweepRecurringInvoices,
} from "./recurring.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Recurring templates materialize ordinary drafts through createDraft — same
// validation and totals math as manual entry — exactly once per period, with
// bounded catch-up after downtime. Fixtures are salted per run.

const SALT = makeRunSalt();
const firmId = randomUUID();
const userId = randomUUID();
const supplier = randomUUID();
const buyer = randomUUID();

const LINES = [
  { description: "Retainer", quantity: "2", unitPrice: "1500", vatRate: "0.075" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
const TODAY = isoDaysAgo(0);

let seq = 0;
function templateInput(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    name: `Retainer ${SALT}-${seq}`,
    cadence: "monthly" as const,
    startDate: TODAY,
    lines: LINES,
    ...overrides,
  };
}

async function invoicesOf(templateId: string) {
  const tid = templateId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const rows = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.firmId, firmId));
  return rows.filter((r) => r.invoiceNumber.startsWith(`REC-${tid}-`));
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `rec-${SALT}@test.local` })
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Recurring Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `Recurring Supplier ${SALT}`,
      tin: "10000000-0011",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Recurring Buyer ${SALT}`,
      tin: "20000000-0011",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
});

test("advanceRunDate: weekly adds 7 days, monthly clamps short months", () => {
  assert.equal(advanceRunDate("2026-07-13", "weekly"), "2026-07-20");
  assert.equal(advanceRunDate("2026-12-28", "weekly"), "2027-01-04");
  assert.equal(advanceRunDate("2026-07-13", "monthly"), "2026-08-13");
  // Jan 31 lands on the shorter month's last day, not a March rollover.
  // The clamped day then sticks (Feb 28 -> Mar 28) — intended: a template
  // anchored to month-end should use the 28th or "monthly on the 1st".
  assert.equal(advanceRunDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(advanceRunDate("2028-01-31", "monthly"), "2028-02-29"); // leap
  assert.equal(advanceRunDate("2026-12-15", "monthly"), "2027-01-15");
});

test("createTemplate rejects percent-style VAT, bad dates and empty lines", async () => {
  await assert.rejects(
    () =>
      createTemplate(
        firmId,
        templateInput({
          lines: [{ ...LINES[0], vatRate: "7.5" }],
        }),
        userId,
      ),
    isDomainError("VAT_RATE_IMPLAUSIBLE", 400),
  );
  await assert.rejects(
    () => createTemplate(firmId, templateInput({ startDate: "2026-02-31" }), userId),
    isDomainError("INVALID_DATE", 400),
  );
  await assert.rejects(
    () => createTemplate(firmId, templateInput({ lines: [] }), userId),
    isDomainError("NO_LINES", 400),
  );
});

test("sweep materializes a due template once, with real invoice math", async () => {
  const template = await createTemplate(firmId, templateInput(), userId);
  await sweepRecurringInvoices();

  const drafts = await invoicesOf(template.id);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].status, "draft");
  assert.equal(drafts[0].issueDate, TODAY);
  assert.equal(drafts[0].subtotal, "3000.00");
  assert.equal(drafts[0].vatTotal, "225.00");
  assert.equal(drafts[0].grandTotal, "3225.00");

  const [after] = await getDb()
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, template.id));
  assert.equal(after.lastInvoiceId, drafts[0].id);
  assert.equal(after.nextRunDate, advanceRunDate(TODAY, "monthly"));

  // Same day, second pass: the advanced nextRunDate is the idempotency gate.
  await sweepRecurringInvoices();
  assert.equal((await invoicesOf(template.id)).length, 1);
});

test("sweep catches up a behind-schedule weekly template one draft per period", async () => {
  const template = await createTemplate(
    firmId,
    templateInput({ cadence: "weekly", startDate: isoDaysAgo(21) }),
    userId,
  );
  await sweepRecurringInvoices();

  // Runs at -21, -14, -7 and 0 days: four periods, four drafts, and the
  // template lands one week in the future.
  const drafts = await invoicesOf(template.id);
  assert.equal(drafts.length, 4);
  assert.deepEqual(
    drafts.map((d) => d.issueDate).sort(),
    [isoDaysAgo(21), isoDaysAgo(14), isoDaysAgo(7), TODAY].sort(),
  );
  const [after] = await getDb()
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, template.id));
  assert.equal(after.nextRunDate, advanceRunDate(TODAY, "weekly"));
});

test("paused templates are skipped; resuming picks the schedule back up", async () => {
  const template = await createTemplate(firmId, templateInput(), userId);
  await setTemplateActive(template.id, false, userId);
  await sweepRecurringInvoices();
  assert.equal((await invoicesOf(template.id)).length, 0);

  await setTemplateActive(template.id, true, userId);
  await sweepRecurringInvoices();
  assert.equal((await invoicesOf(template.id)).length, 1);
});
