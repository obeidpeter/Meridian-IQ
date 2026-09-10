import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compare,
  formatBaseline,
  hotspots,
  parseFinding,
  readBaseline,
  renderReport,
  writeBaseline,
} from "./complexity.mjs";

const finding = (file, label, complexity, line = 1) => ({
  file,
  line,
  label,
  complexity,
});

const findings = [
  finding("src/a.ts", "Function 'submit'", 25, 10),
  finding("src/a.ts", "Arrow function", 30, 40),
  finding("src/a.ts", "Arrow function", 22, 80),
  finding("src/a.ts", "Method 'render'", 12, 120),
  finding("src/b.ts", "Async function 'load'", 21, 5),
];

const baseline = {
  threshold: 20,
  files: {
    "src/a.ts": { "Function 'submit'": [25], "Arrow function": [30, 22] },
    "src/b.ts": { "Async function 'load'": [21] },
  },
};

test("ESLint's message yields the function label and its complexity", () => {
  assert.deepEqual(
    parseFinding(
      "Function 'submit' has a complexity of 25. Maximum allowed is 10.",
    ),
    { label: "Function 'submit'", complexity: 25 },
  );
  assert.deepEqual(
    parseFinding("Async arrow function has a complexity of 11. Maximum allowed is 10."),
    { label: "Async arrow function", complexity: 11 },
  );
  assert.equal(parseFinding("Unexpected any."), null);
});

test("hotspots group the functions over the threshold by file and label, descending", () => {
  assert.deepEqual(hotspots(findings, 20), baseline.files);
  assert.deepEqual(hotspots(findings, 10), {
    "src/a.ts": {
      "Arrow function": [30, 22],
      "Function 'submit'": [25],
      "Method 'render'": [12],
    },
    "src/b.ts": { "Async function 'load'": [21] },
  });
  const report = renderReport(
    [...findings].sort((a, b) => b.complexity - a.complexity),
  );
  assert.equal(report.functionsOver10, 5);
  assert.equal(report.functionsOver20, 4);
  assert.equal(report.maximum, 30);
});

test("an unchanged tree passes, a new hotspot and a grown function fail, a shrunk one can tighten", () => {
  assert.deepEqual(compare(baseline, findings), {
    threshold: 20,
    failures: [],
    tightenable: [],
  });

  const grown = compare(baseline, [
    ...findings.filter((f) => f.label !== "Function 'submit'"),
    finding("src/a.ts", "Function 'submit'", 26, 10),
  ]);
  assert.deepEqual(grown.failures, [
    "src/a.ts:10 Function 'submit' has complexity 26, above its baseline of 25",
  ]);

  const added = compare(baseline, [
    ...findings,
    finding("src/a.ts", "Arrow function", 21, 200),
    finding("src/c.ts", "Function 'fresh'", 40, 3),
  ]);
  assert.deepEqual(added.failures, [
    "src/a.ts:200 Arrow function has complexity 21, over the 20 threshold and not in the baseline",
    "src/c.ts:3 Function 'fresh' has complexity 40, over the 20 threshold and not in the baseline",
  ]);

  const shrunk = compare(baseline, [
    finding("src/a.ts", "Function 'submit'", 23, 10),
    finding("src/a.ts", "Arrow function", 30, 40),
    finding("src/a.ts", "Arrow function", 15, 80),
  ]);
  assert.deepEqual(shrunk.failures, []);
  assert.deepEqual(shrunk.tightenable, [
    "src/a.ts:10 Function 'submit' measures 23 against a baseline of 25",
    "src/a.ts Arrow function (baseline 22) is no longer over the threshold",
    "src/b.ts Async function 'load' (baseline 21) is no longer over the threshold",
  ]);
});

test("a function at the threshold is free; one just over it is a hotspot", () => {
  const at = compare({ threshold: 20, files: {} }, [
    finding("src/a.ts", "Function 'edge'", 20),
  ]);
  assert.deepEqual(at.failures, []);
  const over = compare({ threshold: 20, files: {} }, [
    finding("src/a.ts", "Function 'edge'", 21),
  ]);
  assert.equal(over.failures.length, 1);
});

test("write records the hotspots one label per line and read validates the shape", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "complexity-baseline-"));
  const file = path.join(dir, "complexity-baseline.json");
  const written = writeBaseline(findings, 20, file);
  assert.deepEqual(written, baseline);
  const text = readFileSync(file, "utf8");
  assert.match(text, /"Arrow function": \[30, 22\]/);
  // Files and labels are written in sorted order, whatever order they came in.
  assert.equal(text, formatBaseline(written));
  assert.ok(text.indexOf("Arrow function") < text.indexOf("Function 'submit'"));
  assert.deepEqual(readBaseline(file), baseline);

  writeFileSync(file, JSON.stringify({ threshold: 0, files: {} }));
  assert.throws(() => readBaseline(file), /threshold must be a positive integer/);
  writeFileSync(
    file,
    JSON.stringify({ threshold: 20, files: { "src/a.ts": { "Function 'x'": ["25"] } } }),
  );
  assert.throws(() => readBaseline(file), /must list integer complexities/);
  assert.throws(
    () => readBaseline(path.join(dir, "absent.json")),
    /is missing; run "pnpm run complexity:write"/,
  );
});
