import { registerSweep } from "../pipeline/sweeps";
import { sweepExpiredInvoiceDraftContent } from "./retention";

registerSweep(
  "invoice_drafts.retention",
  async () => {
    await sweepExpiredInvoiceDraftContent();
  },
  { critical: false },
);
