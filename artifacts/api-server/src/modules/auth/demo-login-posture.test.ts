import { test } from "node:test";
import assert from "node:assert/strict";
import { src } from "../../test-helpers/source-pins.ts";

test("demo password seeding stays development-only and refreshes the allowlist", () => {
  const seed = src("bootstrap/seed.ts");
  assert.ok(
    seed.includes('process.env.NODE_ENV !== "production"') &&
      seed.includes('process.env.SEED_DEMO === "true"'),
    "demo seeding requires an explicit non-production opt-in",
  );

  const start = seed.indexOf("async function seedDemoPasswords()");
  const end = seed.indexOf("// --- CPD certification content", start);
  assert.ok(start >= 0 && end > start, "the demo-password seed block exists");
  const passwordSeed = seed.slice(start, end);
  assert.ok(
    passwordSeed.includes(
      "inArray(usersTable.email, [...PRODUCTION_DEMO_EMAILS])",
    ),
    "password updates remain limited to the explicit demo allowlist",
  );
  assert.ok(
    !passwordSeed.includes("isNull(usersTable.passwordHash)"),
    "an opted-in seed replaces stale demo hashes",
  );
});

test("production rejects demo identities before password lookup", () => {
  const session = src("modules/auth/session.ts");
  const lookup = session.indexOf("export async function authenticate");
  assert.ok(lookup >= 0, "the password authenticator exists");
  const guard = session.slice(lookup, lookup + 900);
  assert.ok(
    guard.includes('process.env.NODE_ENV === "production"') &&
      guard.includes("PRODUCTION_DEMO_EMAIL_SET.has(normalizedEmail)") &&
      guard.includes("return null"),
    "production keeps the code-level demo identity wall",
  );
});
