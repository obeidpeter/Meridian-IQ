import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertEvidenceGuardrails,
  EVIDENCE_GUARDRAIL_CATALOG_SQL,
} from "./evidence-guardrails";

test("evidence startup verification accepts the complete catalog through a read-only query", async () => {
  let queried = false;
  await assertEvidenceGuardrails({
    query: async (sql) => {
      queried = true;
      assert.equal(sql, EVIDENCE_GUARDRAIL_CATALOG_SQL);
      assert.ok(sql.includes("enum:message_channel.in_app"));
      assert.doesNotMatch(
        sql.replace(/'(?:''|[^'])*'/g, "''"),
        /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i,
      );
      return { rows: [] };
    },
  });
  assert.equal(queried, true);
});

test("evidence startup verification blocks missing or disabled controls and propagates database failures", async () => {
  await assert.rejects(
    assertEvidenceGuardrails({
      query: async () => ({
        rows: [
          { issue: "constraint:evidence_files_valid_byte_size" },
          { issue: "trigger:evidence_files/meridian_evidence_file_guard" },
        ],
      }),
    }),
    /Evidence Hub guardrails incomplete: constraint:evidence_files_valid_byte_size, trigger:evidence_files\/meridian_evidence_file_guard/,
  );
  const failure = new Error("Synthetic catalog query failure");
  await assert.rejects(
    assertEvidenceGuardrails({
      query: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

test("production verifies evidence guardrails after migration apply and before readiness", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /async function verifyProductionGuardrails\(\): Promise<void> \{\s*try \{\s*await assertEvidenceGuardrails\(pool\);/,
  );
  assert.match(
    source,
    /await applyProductionGuardrails\(\);\s*await verifyProductionGuardrails\(\);/,
  );
  assert.ok(
    source.indexOf("await bootstrapApplication(isProduction)") <
      source.indexOf("markReady()"),
  );
});

test("startup catalog checks name every migration 57 constraint", () => {
  const migration = readFileSync(
    new URL(
      "../../../../lib/db/src/migrations/0057_evidence_hub_guardrails.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const names = [
    ...migration.matchAll(/"(evidence_(?:requests|files|events)_[a-z0-9_]+)"/g),
  ].map((match) => match[1]);
  assert.equal(names.length, 15);
  assert.match(
    migration,
    /ALTER TYPE message_channel ADD VALUE IF NOT EXISTS 'in_app';/,
  );
  assert.equal(
    (migration.match(/'in_app'/g) ?? []).length,
    1,
    "the enum value is added but not consumed before this migration commits",
  );
  for (const name of names)
    assert.ok(
      EVIDENCE_GUARDRAIL_CATALOG_SQL.includes(`'${name}'`),
      `${name} missing from startup verification`,
    );
});
