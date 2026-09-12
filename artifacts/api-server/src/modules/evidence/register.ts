import { registerSweep } from "../pipeline/sweeps";
import {
  EVIDENCE_REMINDER_TIMEOUT_MS,
  sweepEvidenceReminders,
} from "./reminders";
import { sweepEvidenceScans } from "./scanning";

registerSweep(
  "evidence.reminders",
  (signal) => sweepEvidenceReminders(new Date(), { signal }),
  {
    acceptsSignal: true,
    critical: false,
    timeoutMs: EVIDENCE_REMINDER_TIMEOUT_MS,
  },
);
registerSweep("evidence.scans", (signal) => sweepEvidenceScans(signal), {
  acceptsSignal: true,
  critical: false,
  timeoutMs: 30_000,
});
