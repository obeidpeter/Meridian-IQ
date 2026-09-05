import assert from "node:assert/strict";
import { test } from "node:test";
import { invoicePageFilters } from "./list-filters.ts";

test("invoice filtering validates query boundaries before PostgreSQL", () => {
  for (const query of [
    { statusGroup: "unknown" },
    { fromDate: "0000-01-01" },
    { toDate: "2026-02-31" },
    { fromDate: "2026-09-05", toDate: "2026-09-04" },
    { minAmount: "Infinity" },
    { minAmount: "-1" },
    { maxAmount: "1e3" },
    { minAmount: "5", maxAmount: "4.99" },
  ])
    assert.throws(() => invoicePageFilters(query), { code: "INVALID_FILTER" });
  assert.equal(invoicePageFilters({}).length, 0);
  assert.equal(
    invoicePageFilters({
      statusGroup: "draft",
      fromDate: "2026-09-04",
      minAmount: "90071992547409.93",
    }).length,
    3,
  );
});
