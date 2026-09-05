import { registerSweep } from "../pipeline/pipeline";
import { sweepExpiredInvoiceDraftContent } from "./retention";

registerSweep("invoice_drafts.retention", async () => {
  await sweepExpiredInvoiceDraftContent();
});
