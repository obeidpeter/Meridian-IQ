import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listSweeps } from "../pipeline/sweeps";
import { sweepEvidenceReminders } from "./reminders";
import { sweepEvidenceScans } from "./scanning";
import "./register";

test("evidence reminders and scans are bounded optional pipeline steps", () => {
  const steps = listSweeps().filter((step) =>
    step.name.startsWith("evidence."),
  );
  assert.deepEqual(steps.map((step) => step.name).sort(), [
    "evidence.reminders",
    "evidence.scans",
  ]);
  assert.ok(
    steps.every((step) => step.critical === false && step.timeoutMs === 30_000),
  );
  assert.match(
    readFileSync(new URL("../../routes/index.ts", import.meta.url), "utf8"),
    /import "\.\.\/modules\/evidence\/register"/,
  );
});

test("both evidence pipeline hooks honor an already-aborted pass without database or provider access", async () => {
  const registration = readFileSync(
    new URL("./register.ts", import.meta.url),
    "utf8",
  );
  assert.equal(registration.match(/acceptsSignal: true/g)?.length, 2);
  assert.match(
    registration,
    /sweepEvidenceReminders\(new Date\(\), \{ signal \}\)/,
  );
  assert.match(registration, /sweepEvidenceScans\(signal\)/);
  const signal = AbortSignal.abort();
  assert.equal(await sweepEvidenceReminders(new Date(), { signal }), 0);
  await sweepEvidenceScans(signal).then(
    (count) => assert.equal(count, 0),
    (error: unknown) => assert.equal((error as Error).name, "AbortError"),
  );
});
