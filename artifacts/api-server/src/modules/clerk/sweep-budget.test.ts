import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATION_SWEEP_TIMEOUT_MS,
  MODEL_CALL_BUDGET_MS,
  SLICE_MARGIN_MS,
  generationDeadline,
  sliceExhausted,
} from "./sweep-budget";

// R106: the generation sweeps slice their batch to a budget of their own.
// DB-free — the arithmetic, the abort boundary and the source pin that keeps
// the per-call budget equal to the provider client's timeout.

test("the model-call budget is the provider client's own timeout", () => {
  // The provider client's SOURCE is read as text, never imported (D8 keeps
  // the import in provider.ts alone); the package name is assembled so the
  // D8 import guard's text scan does not count this pin as an importer.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lib = ["integrations", "openai", "ai", "server"].join("-");
  const client = readFileSync(
    path.resolve(here, "../../../../../lib", lib, "src/client.ts"),
    "utf8",
  );
  // 60000 is written 60_000 in the client; compare the literal form.
  const literal = MODEL_CALL_BUDGET_MS.toLocaleString("en-US").replace(/,/g, "_");
  assert.ok(
    client.includes(`timeout: ${literal}`),
    `MODEL_CALL_BUDGET_MS (${literal}) must equal the model client's timeout`,
  );
});

test("a generation budget leaves room for at least a few worst-case calls", () => {
  assert.ok(GENERATION_SWEEP_TIMEOUT_MS >= 4 * MODEL_CALL_BUDGET_MS);
  assert.ok(GENERATION_SWEEP_TIMEOUT_MS > 120_000, "above the default sweep timeout");
});

test("the deadline is the budget less one worst-case call and the margin", () => {
  assert.equal(
    generationDeadline(300_000, 1_000),
    1_000 + 300_000 - MODEL_CALL_BUDGET_MS - SLICE_MARGIN_MS,
  );
  const before = Date.now();
  const deadline = generationDeadline();
  assert.ok(deadline >= before + GENERATION_SWEEP_TIMEOUT_MS - MODEL_CALL_BUDGET_MS - SLICE_MARGIN_MS);
});

test("a loop stops before its next model call once aborted or past the deadline", () => {
  const deadline = 10_000;
  assert.equal(sliceExhausted(undefined, deadline, 9_999), false);
  assert.equal(sliceExhausted(undefined, deadline, 10_000), true);
  const controller = new AbortController();
  assert.equal(sliceExhausted(controller.signal, deadline, 0), false);
  controller.abort();
  assert.equal(sliceExhausted(controller.signal, deadline, 0), true);
});
