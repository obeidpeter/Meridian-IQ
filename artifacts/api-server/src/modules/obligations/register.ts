import { registerSweep } from "../pipeline/pipeline";
import { sweepObligationReminders } from "./reminders";

// Wires the obligation deadline-reminder sweep onto the shared 1-minute loop
// (the invoice/register.ts pattern). Cheap when nothing is due — an indexed
// scan plus the sent-ledger's NOT EXISTS — and kept out of reminders.ts so
// that module stays importable by node --test without the pipeline worker's
// dependency graph.
registerSweep(() => sweepObligationReminders());
