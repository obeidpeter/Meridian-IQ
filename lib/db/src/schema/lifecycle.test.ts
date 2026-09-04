import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  submissionAttemptSequence,
  submissionAttemptsTable,
} from "./lifecycle.ts";

test("submission attempt ordering rolls out without truncating existing rows", () => {
  const config = getTableConfig(submissionAttemptsTable);
  const seq = config.columns.find((column) => column.name === "seq");

  assert.ok(seq, "submission_attempts.seq must exist");
  assert.equal(seq.notNull, false, "the publish-safe column stays nullable");
  assert.equal(
    seq.hasDefault,
    true,
    "new and backfilled rows receive a sequence",
  );
  assert.notEqual(
    seq.default,
    undefined,
    "the sequence default must be explicit",
  );
  assert.ok(
    config.checks.some(
      (constraint) => constraint.name === "submission_attempts_seq_not_null",
    ),
    "the database must still reject null sequence values",
  );
  assert.equal(
    submissionAttemptSequence.seqName,
    "submission_attempts_seq_seq",
  );
});
