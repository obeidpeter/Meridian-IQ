import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  invoiceFilterKey,
} from "./cursor.ts";

const id = "c5b22cb1-c56e-4b56-ae4e-b29af07042b1";
test("invoice cursor retains database microsecond ordering and binds the full filter", () => {
  const filter = invoiceFilterKey({
    firm: "a",
    q: "invoice",
    statusGroup: "draft",
  });
  const timestamp = "2026-09-04T12:34:56.123456Z";
  const cursor = encodeInvoiceCursor(timestamp, id, filter);
  assert.deepEqual(decodeInvoiceCursor(cursor, filter), { timestamp, id });
  assert.throws(
    () => decodeInvoiceCursor(cursor, invoiceFilterKey({ firm: "b" })),
    /different filter/,
  );
});
test("malformed or oversized invoice cursors fail as domain errors", () => {
  for (const cursor of [
    "",
    "@bad",
    "a".repeat(1025),
    "e30",
    encodeInvoiceCursor("not-a-date", id, "f"),
    encodeInvoiceCursor("2026-09-04T12:34:56.123456Z", "no-id", "f"),
  ]) {
    assert.throws(() => decodeInvoiceCursor(cursor, "f"), {
      code: "INVALID_CURSOR",
    });
  }
  for (const date of [
    "0000-01-01T00:00:00.000000Z",
    "2026-02-31T00:00:00.000000Z",
    "2026-09-04T24:00:00.000000Z",
  ]) {
    assert.throws(
      () => decodeInvoiceCursor(encodeInvoiceCursor(date, id, "f"), "f"),
      { code: "INVALID_CURSOR" },
    );
  }
});
