import { useState } from "react";
import { lazyRoute } from "./route-recovery";
import type { EvidenceHubProps } from "./evidence-hub";

// Preserve barrel consumers without evaluating feature dialogs at app startup.
// Routes that already have a lazy boundary use the /evidence entry directly.
export function EvidenceHub(props: EvidenceHubProps) {
  const [Hub] = useState(() =>
    lazyRoute(() =>
      import("./evidence-hub").then((module) => ({
        default: module.EvidenceHub,
      })),
    ),
  );
  return <Hub {...props} />;
}
