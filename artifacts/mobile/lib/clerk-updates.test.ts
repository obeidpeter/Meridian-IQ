import { test } from "node:test";
import assert from "node:assert/strict";
import {
  digestSourceNote,
  statementMonthLabel,
  updatesAudience,
} from "./clerk-updates.ts";

// The role branch is the load-bearing piece: GET /clerk/digest 403s a
// client_user BY ROLE (its facts span the whole client book — SEC-03), so
// the screen must route a client to their own statements and never call the
// refused endpoint.

test("firm staff with clerk.ask get the weekly-digest surface", () => {
  assert.equal(
    updatesAudience("firm_admin", ["clerk.ask", "clerk.capture"]),
    "firm",
  );
  assert.equal(updatesAudience("firm_staff", ["clerk.ask"]), "firm");
});

test("firm staff without clerk.ask get no surface (capability gate)", () => {
  assert.equal(updatesAudience("firm_admin", ["clerk.capture"]), null);
  assert.equal(updatesAudience("firm_staff", []), null);
  assert.equal(updatesAudience("firm_staff", undefined), null);
});

test("a client_user routes to statements, never the refused digest", () => {
  // clerk.ask was widened to client_user for Ask only — a client holding
  // BOTH capabilities still branches to statements, because the digest
  // endpoint refuses the role regardless of capability.
  assert.equal(
    updatesAudience("client_user", ["clerk.capture", "clerk.ask"]),
    "client",
  );
  assert.equal(updatesAudience("client_user", ["clerk.capture"]), "client");
  assert.equal(updatesAudience("client_user", ["clerk.ask"]), null);
});

test("platform roles and anonymous principals get no updates surface", () => {
  assert.equal(updatesAudience("operator", ["clerk.use", "clerk.ask"]), null);
  assert.equal(updatesAudience("auditor", ["clerk.ask"]), null);
  assert.equal(updatesAudience(undefined, ["clerk.ask"]), null);
  assert.equal(updatesAudience(null, null), null);
});

test("statementMonthLabel renders the server's month without Date parsing", () => {
  // String-split on purpose: new Date("2026-06-01") is UTC midnight, which
  // is still May 31 in timezones west of UTC — the label must not drift.
  assert.equal(statementMonthLabel("2026-06-01"), "June 2026");
  assert.equal(statementMonthLabel("2025-12-01"), "December 2025");
  assert.equal(statementMonthLabel("2026-01-01"), "January 2026");
});

test("statementMonthLabel tolerates malformed input", () => {
  assert.equal(statementMonthLabel(""), "—");
  assert.equal(statementMonthLabel("2026"), "—");
  // An out-of-range month degrades to the raw token, never undefined.
  assert.equal(statementMonthLabel("2026-13-01"), "13 2026");
});

test("digestSourceNote distinguishes Clerk narrative from template fallback", () => {
  assert.equal(digestSourceNote("clerk"), "Written by Clerk");
  assert.equal(digestSourceNote("template"), "Generated from your data");
  // Unknown sources from a newer server read as deterministic, never crash
  // and never overclaim model authorship.
  assert.equal(digestSourceNote("something_new"), "Generated from your data");
});
