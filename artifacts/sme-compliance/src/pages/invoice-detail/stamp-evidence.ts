import type { StampRecord } from "@workspace/api-client-react";

export function stampEvidence(stamp: StampRecord) {
  const provider = stamp.provider?.trim();
  const complete = !!(
    stamp.irn?.trim() &&
    stamp.csid?.trim() &&
    stamp.signedArtifactRef?.trim()
  );
  if (
    stamp.environment === "sandbox" ||
    provider?.toLowerCase() === "simulator"
  ) {
    return {
      label: "Sandbox / simulated stamp",
      description: "This is not a live production stamp.",
    };
  }
  if (stamp.environment === "live" && provider && complete) {
    return {
      label: "Live stamp evidence",
      description:
        "The record includes a live environment, a non-simulator provider, IRN, CSID and a signed artifact reference.",
    };
  }
  return {
    label: "Stamp provenance unverified",
    description:
      "Live production stamping is not established. Provider, environment or complete signed evidence is missing.",
  };
}
