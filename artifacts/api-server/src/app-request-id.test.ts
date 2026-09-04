import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequestId } from "./lib/request-id.ts";

test("request references retain safe values and replace unsafe input", () => {
  assert.equal(resolveRequestId("support.req-42"), "support.req-42");
  assert.equal(resolveRequestId(["first", "second"]), "first");
  assert.equal(
    resolveRequestId("not safe for logs", () => "generated-id"),
    "generated-id",
  );
  assert.equal(
    resolveRequestId("x".repeat(129), () => "generated-id"),
    "generated-id",
  );
});
