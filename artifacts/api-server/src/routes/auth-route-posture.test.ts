import { test } from "node:test";
import assert from "node:assert/strict";
import { routeBlock, src } from "../test-helpers/source-pins.ts";

test("TOTP challenge accepts only the account's exact session epoch", () => {
  const block = routeBlock(src("routes/auth.ts"), "/auth/totp/challenge");
  assert.ok(
    block.includes("verified.epoch !== user.sessionEpoch"),
    "a signed pending token from any non-current epoch must be rejected",
  );
});

test("email verification issuance compare-and-sets the saved address", () => {
  const block = routeBlock(
    src("routes/staff.ts"),
    "/staff/notification-preferences/request-email-verification",
  );
  const updateAt = block.indexOf(".update(staffNotificationPreferencesTable)");
  const whereAt = block.indexOf(".where(", updateAt);
  const returningAt = block.indexOf(".returning(", whereAt);
  assert.ok(updateAt >= 0 && whereAt >= 0 && returningAt >= 0);
  assert.ok(
    block
      .slice(whereAt, returningAt)
      .includes("staffNotificationPreferencesTable.email, row.email"),
    "a code sent to the old inbox must not attach to a concurrently saved address",
  );
});
