import { registerSweep } from "../pipeline/pipeline";
import { sweepDeadlineReminders } from "./reminders";
import { sweepRecurringInvoices } from "./recurring";

// Wires the invoice compliance sweeps onto the shared 1-minute loop. Both are
// cheap when nothing is due (indexed scans, idempotency ledgers/CAS make the
// frequent cadence cost nothing) and kept out of their modules so those stay
// importable by node --test without the pipeline worker's dependency graph.
registerSweep(() => sweepDeadlineReminders());
registerSweep(() => sweepRecurringInvoices());
