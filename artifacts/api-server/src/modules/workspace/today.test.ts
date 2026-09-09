import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  addTodayCounts,
  datePrioritySql,
  dueDate,
  dueDateSql,
  dueDescription,
  emptyTodayCounts,
  priorityFor,
  sortToday,
  todayCountFields,
} from "./today.ts";
import {
  businessDetailsComplete,
  invoiceValidationComplete,
} from "./onboarding.ts";

const now = new Date("2026-09-09T10:00:00.000Z");

test("any elapsed deadline is urgent, including one millisecond and less than 24 hours", () => {
  for (const elapsed of [1, 60 * 60 * 1000, 23 * 60 * 60 * 1000]) {
    const due = new Date(now.getTime() - elapsed);
    assert.equal(priorityFor(due, now), "urgent");
    assert.equal(dueDescription(due, now), "1 day overdue");
  }
  assert.equal(priorityFor(now, now), "high");
  assert.equal(
    priorityFor(new Date(now.getTime() + 3 * 86400000), now),
    "high",
  );
  assert.equal(
    priorityFor(new Date(now.getTime() + 3 * 86400000 + 1), now),
    "normal",
  );
  assert.equal(priorityFor(null, now), "normal");
});

test("day-only deadlines and descriptions use the Nigerian calendar", () => {
  assert.equal(
    dueDate("2026-09-09")?.toISOString(),
    "2026-09-09T22:59:59.000Z",
  );
  assert.equal(dueDescription(dueDate("2026-09-09"), now), "Due today");
  assert.equal(dueDescription(dueDate("2026-09-10"), now), "Due tomorrow");
  assert.equal(dueDescription(dueDate("2026-09-12"), now), "Due in 3 days");
  assert.equal(dueDescription(null, now), "No due date");
});

test("ties use stable ID order even when deadlines match, with null dates last", () => {
  const rows = [
    { id: "b", priority: "urgent" as const, dueAt: now },
    { id: "c", priority: "urgent" as const, dueAt: null },
    { id: "a", priority: "urgent" as const, dueAt: now },
    { id: "d", priority: "high" as const, dueAt: new Date(0) },
  ];
  assert.deepEqual(
    sortToday(rows).map((row) => row.id),
    ["a", "b", "c", "d"],
  );
});

test("global top K can be formed from identically ranked top K of each source", () => {
  const sources = Array.from({ length: 4 }, (_, source) =>
    Array.from({ length: 150 }, (_, row) => ({
      id: `${source}:${String(150 - row).padStart(3, "0")}`,
      priority: (["low", "normal", "urgent", "high"] as const)[row % 4],
      dueAt: row % 7 ? new Date(now.getTime() + (row % 3) * 86400000) : null,
    })),
  );
  for (const limit of [1, 2, 24, 50]) {
    const actual = sortToday(
      sources.flatMap((rows) => sortToday([...rows]).slice(0, limit)),
    ).slice(0, limit);
    const expected = sortToday(sources.flat()).slice(0, limit);
    assert.deepEqual(actual, expected);
  }
});

test("summary adds source aggregates, not visible row counts", () => {
  assert.deepEqual(
    addTodayCounts([
      { total: 120, urgent: 30, dueSoon: 40, blocked: 20 },
      undefined,
      { total: 80, urgent: 12, dueSoon: 5, blocked: 3 },
    ]),
    { total: 200, urgent: 42, dueSoon: 45, blocked: 23 },
  );
  assert.deepEqual(addTodayCounts([]), emptyTodayCounts());
});

test("SQL count windows are whole-population and use the supplied clock and Lagos timezone", () => {
  const dialect = new PgDialect();
  const due = dueDateSql(sql`due_date`);
  const rank = datePrioritySql(due, now, { failed: sql`status = 'failed'` });
  const fields = todayCountFields(due, rank, sql`status`, now);
  const compiled = dialect.sqlToQuery(
    sql`${fields.total}, ${fields.urgent}, ${fields.dueSoon}, ${fields.blocked}`,
  );
  assert.match(compiled.sql, /count\(\*\) over \(\)/);
  assert.match(compiled.sql, /Africa\/Lagos/);
  assert.match(compiled.sql, /'blocked', 'failed'/);
  assert.doesNotMatch(compiled.sql, /\bnow\(\)|limit|order by/i);
  assert.ok(compiled.params.includes(now.toISOString()));
  assert.ok(compiled.params.includes("2026-09-12T10:00:00.000Z"));
});

test("business detail proof requires the canonical identity and address, not TIN alone", () => {
  const complete = {
    legalName: "Sample",
    tin: "123",
    street: "1 Main",
    city: "Lagos",
    countryCode: "NG",
  };
  assert.equal(businessDetailsComplete(complete), true);
  assert.equal(businessDetailsComplete(undefined), false);
  for (const field of ["legalName", "tin", "street", "city", "countryCode"]) {
    assert.equal(
      businessDetailsComplete({ ...complete, [field]: " " }),
      false,
      field,
    );
  }
});

test("drafts, cancelled invoices and editable failures do not prove current validation", () => {
  for (const status of [undefined, "draft", "failed", "cancelled", "unknown"]) {
    assert.equal(invoiceValidationComplete(status), false, status);
  }
  for (const status of [
    "validated",
    "submitted",
    "stamped",
    "confirmed",
    "settled",
    "credited",
  ]) {
    assert.equal(invoiceValidationComplete(status), true, status);
  }
});
