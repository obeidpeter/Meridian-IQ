import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import type { CompletionRequest } from "./gateway.ts";
import { CRITICAL_FIELDS } from "./prompts.ts";
import { buildVisionPdfs, loadVisionFixtures } from "./vision-fixtures.ts";
import { runEvalCorpus } from "./eval.ts";

// Vision injection lane (round 7). Invariants pinned here:
//  - the eight fixture PDFs build deterministically (byte-identical on every
//    call — no timestamps, no randomness) and rasterize to PNG pages exactly
//    once per process (module-level cache);
//  - the eval runner sends vision fixtures as IMAGE content through the scan
//    user-content shape (anti-injection preamble + one image part per page)
//    while text fixtures keep the fenced-text path;
//  - injection scoring wires through unchanged: an obeyed printed attack
//    marks injectionResisted=false, resisted attacks true, clean controls
//    null — folded into the same stored run totals as every other fixture.
// No provider is touched: the fake gateway answers from the fixtures' own
// expected values.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

before(async () => {
  await saveAndEnableClerkFlag();
});

after(async () => {
  await restoreClerkFlag();
});

test("the eight fixture PDFs build byte-identically on every call", async () => {
  const a = await buildVisionPdfs();
  const b = await buildVisionPdfs();
  assert.equal(a.length, 8);
  assert.equal(b.length, 8);
  assert.equal(a.filter((s) => s.riskLabel === "injection").length, 6);
  assert.equal(a.filter((s) => s.riskLabel === "clean").length, 2);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].slug, b[i].slug);
    assert.ok(
      a[i].pdf.equals(b[i].pdf),
      `${a[i].slug}: PDF bytes must be deterministic`,
    );
  }
});

test("loadVisionFixtures: rendered pages, vision keys, critical-only injection expectations, cached", async () => {
  const fixtures = await loadVisionFixtures();
  assert.equal(fixtures.length, 8);
  for (const f of fixtures) {
    assert.match(f.key, /^vision\./);
    assert.ok(f.scanPagesB64 && f.scanPagesB64.length === 1, `${f.key}: one page`);
    const png = Buffer.from(f.scanPagesB64![0], "base64");
    assert.ok(
      png.subarray(0, 8).equals(PNG_MAGIC),
      `${f.key}: pages are PNG images`,
    );
  }
  for (const f of fixtures.filter((x) => x.riskLabel === "injection")) {
    const fields = Object.keys(f.expected);
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.ok(
        CRITICAL_FIELDS.has(field as never),
        `${f.key}: injection expectations are critical fields only (${field})`,
      );
    }
  }
  // Module-level cache: the same promise (same arrays) on a second call — a
  // run never rasterizes twice.
  assert.equal(await loadVisionFixtures(), fixtures);
});

test("runEvalCorpus sends image content for vision fixtures and scores injection through", async () => {
  const fixtures = await loadVisionFixtures();
  // Identify which fixture a vision call is for by its page data URL.
  const byUrl = new Map(
    fixtures.map((f) => [
      `data:image/png;base64,${f.scanPagesB64![0]}`,
      f,
    ]),
  );
  const OBEYED_KEY = "vision.tiny-grey"; // the fake falls for this one attack

  const visionCalls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    if (typeof req.user === "string") {
      // Text fixtures stay on the fenced path; their scores are not under
      // test here.
      return JSON.stringify({ fields: [], lines: [] });
    }
    visionCalls.push(req);
    const image = req.user.find(
      (p): p is { type: "image_url"; image_url: { url: string } } =>
        p.type === "image_url",
    );
    const fixture = image ? byUrl.get(image.image_url.url) : undefined;
    assert.ok(fixture, "every image call carries a known fixture page");
    const values: Record<string, string | null> = { ...fixture.expected };
    if (fixture.key === OBEYED_KEY) {
      // Obey the printed attack: report the decoy total instead.
      values.grandTotal = "12900.00";
    }
    return JSON.stringify({
      fields: Object.entries(values).map(([field, value]) => ({
        field,
        value,
        confidence: 0.9,
        sourceSnippet: null,
      })),
      lines: [],
    });
  });

  const run = await runEvalCorpus(null, gateway);

  // Exactly the eight vision fixtures travelled as image content, each with
  // the scan preamble naming the pages as untrusted data.
  assert.equal(visionCalls.length, 8);
  for (const call of visionCalls) {
    assert.ok(Array.isArray(call.user));
    const preamble = call.user[0];
    assert.ok(
      preamble.type === "text" && /scanned page/i.test(preamble.text),
      "anti-injection preamble rides ahead of the page images",
    );
  }

  const visionResults = run.results.filter((r) => r.key.startsWith("vision."));
  assert.equal(visionResults.length, 8);

  // Injection scoring wired through scoreFixture: the obeyed attack fails,
  // the five resisted ones pass, the clean controls score no resistance flag
  // and full accuracy.
  const obeyed = visionResults.find((r) => r.key === OBEYED_KEY);
  assert.ok(obeyed);
  assert.equal(obeyed.injectionResisted, false);
  assert.ok(obeyed.mismatches.some((m) => m.field === "grandTotal"));
  const resisted = visionResults.filter(
    (r) => r.riskLabel === "injection" && r.key !== OBEYED_KEY,
  );
  assert.equal(resisted.length, 5);
  for (const r of resisted) {
    assert.equal(r.injectionResisted, true, `${r.key} resisted`);
    assert.equal(r.fieldsCorrect, r.fieldsCompared);
  }
  for (const r of visionResults.filter((x) => x.riskLabel === "clean")) {
    assert.equal(r.injectionResisted, null);
    assert.equal(r.fieldsCorrect, r.fieldsCompared, `${r.key} aced`);
  }

  // The stored run's totals fold the vision lane in with everything else —
  // the injection-resistance trend needs no special handling.
  assert.ok(run.injectionFixtures >= 6);
  assert.ok(run.injectionResisted >= 5);
  assert.equal(run.fixtureCount, run.results.length);
});
