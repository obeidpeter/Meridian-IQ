import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelRateLimitedRoute,
  principalBypassesTenantContext,
  requestSkipsTenantContext,
} from "./request-policy.ts";

test("request policy distinguishes method-scoped and parameterized routes", () => {
  assert.equal(requestSkipsTenantContext("POST", "/api/clerk/ask"), true);
  assert.equal(requestSkipsTenantContext("GET", "/api/clerk/ask"), false);
  assert.equal(
    requestSkipsTenantContext("POST", "/api/clerk/cases/case-1/retry"),
    true,
  );
  assert.equal(
    requestSkipsTenantContext("POST", "/api/clerk/cases/case-1/retry/extra"),
    false,
  );
});

test("model policy covers fixed and parameterized provider routes", () => {
  assert.equal(isModelRateLimitedRoute("GET", "/api/compliance-pack"), true);
  assert.equal(
    isModelRateLimitedRoute("POST", "/api/engagements/eng-1/narrative"),
    true,
  );
  assert.equal(isModelRateLimitedRoute("GET", "/api/healthz"), false);
});

test("tenant bypass derives only from the authenticated principal", () => {
  assert.equal(principalBypassesTenantContext(undefined), true);
  assert.equal(
    principalBypassesTenantContext({
      userId: "user-1",
      role: "operator",
      firmId: null,
      clientPartyId: null,
      buyerPartyId: null,
    }),
    true,
  );
  assert.equal(
    principalBypassesTenantContext({
      userId: "user-2",
      role: "firm_admin",
      firmId: "firm-1",
      clientPartyId: null,
      buyerPartyId: null,
    }),
    false,
  );
});
