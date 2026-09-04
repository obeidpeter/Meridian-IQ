import { test } from "node:test";
import assert from "node:assert/strict";
import { keyRingEnvName, legacyTokenPathEnabled } from "../../lib/op-token.ts";
import { ROLE_CAPABILITIES } from "../auth/rbac.ts";
import { COLLECTION_ACCOUNT_FEED_SPECIFICATION } from "./feed-spec.ts";

test("bank users receive only the purpose-built aggregate capability", () => {
  assert.deepEqual(ROLE_CAPABILITIES.bank_user, ["credit.data_room.read"]);
  assert.equal(ROLE_CAPABILITIES.bank_user.includes("invoice.read"), false);
  assert.equal(ROLE_CAPABILITIES.bank_user.includes("party.read"), false);
  assert.equal(ROLE_CAPABILITIES.bank_user.includes("audit.read"), false);
});

test("the collection feed profile matches the executable signed rail", () => {
  assert.equal(
    COLLECTION_ACCOUNT_FEED_SPECIFICATION.authentication.keyRingEnvironment,
    keyRingEnvName("COLLECTION_WEBHOOK_TOKEN"),
  );
  assert.deepEqual(
    COLLECTION_ACCOUNT_FEED_SPECIFICATION.authentication.signedComponents,
    ["timestamp", "method", "path", "body_sha256"],
  );
  assert.equal(
    COLLECTION_ACCOUNT_FEED_SPECIFICATION.path,
    "/api/collections/inbound",
  );
  assert.equal(
    COLLECTION_ACCOUNT_FEED_SPECIFICATION.acknowledgementStatus,
    202,
  );
});

test("legacy collection tokens default off in production", () => {
  const nodeEnv = process.env.NODE_ENV;
  const legacy = process.env.OP_LEGACY_TOKENS;
  process.env.NODE_ENV = "production";
  delete process.env.OP_LEGACY_TOKENS;
  try {
    assert.equal(legacyTokenPathEnabled(), false);
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (legacy === undefined) delete process.env.OP_LEGACY_TOKENS;
    else process.env.OP_LEGACY_TOKENS = legacy;
  }
});
