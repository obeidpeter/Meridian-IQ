import type { InvoiceStatus } from "@workspace/api-client-react";

import type { BadgeTone } from "@/components/ui";

// Mirrors the web vault's status tones so both clients tell the same story.
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: "neutral",
  validated: "info",
  submitted: "warning",
  stamped: "success",
  confirmed: "success",
  settled: "success",
  failed: "critical",
  cancelled: "neutral",
  credited: "neutral",
};
