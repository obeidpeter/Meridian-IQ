import assert from "node:assert/strict";
import { test } from "node:test";
import { railEnvironmentFromEnv } from "../rails/transports/http.ts";
import {
  submissionJourneySteps,
  type SubmissionProof,
} from "./submission-journey.ts";

const ready: SubmissionProof = {
  status: "validated",
  consent: true,
  approval: true,
  canSubmit: true,
  enabled: true,
  liveService: true,
};
const stamp = {
  environment: railEnvironmentFromEnv({ RAIL_ENVIRONMENT: "live" }),
  provider: "http",
  irn: "IRN-1",
  csid: "CSID-1",
  signedArtifactRef: "signed-1",
};
function steps(proof: SubmissionProof) {
  return Object.fromEntries(
    submissionJourneySteps(proof, "/invoices/test", "/consent").map((item) => [
      item.id,
      item,
    ]),
  );
}

test("saved drafts, internal approval and queue entry cannot claim official acceptance", () => {
  for (const status of ["draft", "validated", "submitted", "failed"]) {
    const result = steps({ ...ready, status });
    assert.equal(result.invoice_acknowledgement.complete, false);
    assert.equal(result.invoice_submission.complete, status === "submitted");
  }
  assert.match(
    steps({ ...ready, status: "submitted" }).invoice_acknowledgement
      .description,
    /do not submit it again/i,
  );
});

test("each actual readiness blocker is named, and validation is not silently skipped", () => {
  for (const [key, pattern] of [
    ["consent", /grant submission consent/i],
    ["approval", /different authorised reviewer/i],
    ["canSubmit", /authorised member/i],
    ["enabled", /enable invoice submission/i],
    ["liveService", /live submission service/i],
  ] as const) {
    assert.match(
      steps({ ...ready, [key]: false }).invoice_submission.blockedReason ?? "",
      pattern,
    );
  }
  assert.match(
    steps({ ...ready, status: "failed" }).invoice_submission.blockedReason ??
      "",
    /failed submission/i,
  );
  assert.equal(steps(ready).invoice_submission.blockedReason, undefined);
});

test("acceptance requires the invoice state and complete production stamp provenance", () => {
  for (const status of ["stamped", "confirmed", "settled", "credited"]) {
    assert.equal(
      steps({ ...ready, status, stamp }).invoice_acknowledgement.complete,
      true,
    );
  }
  for (const incomplete of [
    { ...stamp, environment: "sandbox" },
    { ...stamp, environment: "production" },
    { ...stamp, provider: "simulator" },
    { ...stamp, provider: " Simulator " },
    { ...stamp, provider: "" },
    { ...stamp, irn: "" },
    { ...stamp, csid: "" },
    { ...stamp, signedArtifactRef: "" },
  ]) {
    const result = steps({ ...ready, status: "stamped", stamp: incomplete });
    assert.equal(result.invoice_acknowledgement.complete, false);
    assert.match(
      result.invoice_acknowledgement.description,
      /test or incomplete/,
    );
  }
  assert.equal(
    steps({ ...ready, status: "draft", stamp }).invoice_acknowledgement
      .complete,
    false,
  );
});

test("current service configuration cannot upgrade an old sandbox stamp", () => {
  const result = steps({
    ...ready,
    status: "stamped",
    stamp: { ...stamp, environment: "sandbox" },
  });
  assert.equal(result.invoice_service.complete, true);
  assert.equal(result.invoice_submission.complete, true);
  assert.equal(result.invoice_acknowledgement.complete, false);
  assert.match(
    result.invoice_service.description,
    /does not prove a successful connection/i,
  );
});

test("revoked consent stays visible even when an earlier submission is recorded", () => {
  const result = steps({ ...ready, status: "stamped", stamp, consent: false });
  assert.equal(result.invoice_consent.complete, false);
  assert.equal(result.invoice_consent.href, "/consent");
  assert.equal(result.invoice_acknowledgement.complete, true);
  assert.equal(result.invoice_submission.blockedReason, undefined);
});
