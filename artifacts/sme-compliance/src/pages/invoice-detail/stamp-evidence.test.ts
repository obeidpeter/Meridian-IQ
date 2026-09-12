import { expect, test } from "vitest";
import type { StampRecord } from "@workspace/api-client-react";
import { stampEvidence } from "./stamp-evidence";

const complete = {
  environment: "live",
  provider: "accredited-provider",
  irn: "irn",
  csid: "csid",
  signedArtifactRef: "artifact",
} as StampRecord;
test("only canonical live provenance and complete signed fields establish live evidence", () => {
  expect(stampEvidence(complete).label).toBe("Live stamp evidence");
});
test.each([
  { environment: undefined },
  { environment: "production" },
  { environment: " LIVE " },
  { provider: "  " },
  { provider: undefined },
  { irn: " " },
  { csid: " " },
  { signedArtifactRef: " " },
])("incomplete or unknown provenance stays unverified: %j", (fields) => {
  expect(stampEvidence({ ...complete, ...fields }).label).toBe(
    "Stamp provenance unverified",
  );
});
test.each([
  { environment: "sandbox" },
  { provider: "simulator" },
  { provider: " Simulator " },
])("sandbox/simulator is never live: %j", (fields) => {
  expect(stampEvidence({ ...complete, ...fields }).label).toBe(
    "Sandbox / simulated stamp",
  );
});
